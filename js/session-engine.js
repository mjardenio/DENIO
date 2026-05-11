import { db } from "./firebase.js";
import { arrayUnion, collection, doc, increment, onSnapshot, serverTimestamp, setDoc } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { createAdminNotification } from "./admin-services.js";
import { buildCoachJayMessage } from "./adaptive-engine.js";
import { completeScheduledWorkout, formatWorkoutDayLabel, getAppDateKey, APP_TIME_ZONE, isValidLiftDayNumber, normalizeLiftDayNumber } from "./schedule-engine.js";

const STORAGE_KEY = "denio_active_session";
const SESSION_META_KEY = "current_session_data";

const coachJayPools = {
    motivational: [
        "You are earning every rep today. Keep stacking wins!",
        "Strong effort. Show up for this set and own it.",
        "This is where your consistency turns into progress.",
        "One focused set at a time. You got this.",
        "Stay locked in. Your future self will thank you.",
        "You're moving with intent, keep that momentum alive.",
        "Small wins here become big changes outside the gym.",
        "Keep your rhythm. You are doing great work.",
        "This session is your proof that discipline works.",
        "You came to work, now finish with purpose."
    ],
    technique: [
        "Control the tempo and keep tension on the target muscle.",
        "Brace your core before each rep and breathe with control.",
        "Full range, clean form, no rushed reps.",
        "Drive through the working muscle, not momentum.",
        "Shoulders down, chest proud, move with precision.",
        "Slow the lowering phase to maximize stimulus.",
        "Set your posture first, then attack each rep.",
        "Stay stable through the trunk and move with intent.",
        "Own the eccentric, then explode with control.",
        "Quality reps now protect your progress later."
    ],
    congratulatory: [
        "Set complete. Great control and composure.",
        "Nice work. That set moved your progress forward.",
        "Clean execution. Keep that same focus next set.",
        "Excellent pacing, now recover and reload.",
        "Solid set. You're building real strength here.",
        "Great grit on that one. Stay sharp.",
        "That was clean and consistent. Exactly what we want.",
        "Strong finish on that effort. Keep it rolling.",
        "Another quality set in the books.",
        "Your consistency is showing up in every set."
    ],
    intensity: [
        "Last reps should challenge you. Stay disciplined.",
        "Push hard, but protect your form.",
        "If you can do more with perfect form, take it.",
        "This is the growth zone. Lean into it.",
        "Strong mind-muscle connection. Finish strong.",
        "No sloppy reps. Quality effort over ego.",
        "Fight for the last two reps with clean mechanics.",
        "Fatigue is expected now. Technique stays non-negotiable.",
        "This is where focus beats comfort.",
        "Commit to this rep like it decides the whole set."
    ]
};

function hasExternalLoad(exercise) {
    const equipment = Array.isArray(exercise.equipment) ? exercise.equipment : [exercise.equipment || exercise.equipment_needed || ""];
    const text = equipment.join(" ").toLowerCase();
    return !(text.includes("none") || text.includes("no equipment") || text.includes("bodyweight"));
}

function formatClock(totalSeconds) {
    const h = String(Math.floor(totalSeconds / 3600)).padStart(2, "0");
    const m = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0");
    const s = String(totalSeconds % 60).padStart(2, "0");
    return `${h}:${m}:${s}`;
}

function parseRepRange(repRange) {
    const source = String(repRange || "");
    const values = source.match(/\d+/g);
    if (!values?.length) return { min: 8, max: 12, avg: 10 };
    if (values.length === 1) {
        const num = Number(values[0]);
        return { min: num, max: num, avg: num };
    }
    const min = Number(values[0]);
    const max = Number(values[1]);
    return { min, max, avg: Math.round((min + max) / 2) };
}

function randomInRange(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function getExerciseTypeFromRepRange(exercise) {
    const repData = parseRepRange(exercise.rep_range || exercise.reps);
    if (repData.max <= 6) return "heavy strength";
    if (repData.max <= 12) return "hypertrophy";
    return "endurance/fat loss";
}

function calculateRecommendedRest(exercise) {
    const exerciseType = getExerciseTypeFromRepRange(exercise);
    if (exerciseType === "heavy strength") return randomInRange(90, 120);
    if (exerciseType === "hypertrophy") return randomInRange(60, 90);
    return randomInRange(30, 45);
}

function hydrateActiveSession() {
    const activeSessionRaw = localStorage.getItem(STORAGE_KEY);
    const currentSessionRaw = localStorage.getItem(SESSION_META_KEY);

    if (activeSessionRaw) {
        const parsed = JSON.parse(activeSessionRaw);
        if (parsed?.meta?.exercises?.length) return parsed;
    }

    if (!currentSessionRaw) return null;
    const meta = JSON.parse(currentSessionRaw);
    if (!meta?.exercises?.length) return null;

    const fallback = {
        meta,
        state: {
            currentExerciseIndex: 0,
            currentSetIndex: 0,
            completedSetIds: [],
            setLogs: {},
            startedAt: Date.now(),
            elapsedSeconds: 0,
            totalVolume: 0,
            maxWeight: 0,
            rest: null,
            coachHistory: []
        }
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback));
    return fallback;
}

export function initSessionEngine({ user, trueCurrentAppDay }) {
    const wrapper = document.getElementById("sessionWrapper");
    if (!wrapper) return;

    document.body.classList.add("session-page");
    document.body.style.overflow = "hidden";

    const dom = {
        stopwatch: document.getElementById("mainStopwatch"),
        progress: document.getElementById("exProgress"),
        title: document.getElementById("exTitle"),
        desc: document.querySelector("#exerciseDetailsView .ex-desc"),
        setsWrapper: document.getElementById("setsWrapper"),
        mediaContainer: document.querySelector(".media-container"),
        mediaPlaceholder: document.querySelector(".media-placeholder"),
        actionBtn: document.querySelector(".action-container .btn-main"),
        restOverlay: document.getElementById("restTimerOverlay"),
        restDisplay: document.getElementById("restTimeDisplay"),
        exerciseDetailsView: document.getElementById("exerciseDetailsView"),
        coachJayView: document.getElementById("coachJayView"),
        restCoachMsg: document.getElementById("restCoachMsg"),
        wrapper
    };

    const activeSession = hydrateActiveSession();
    if (!activeSession?.meta?.exercises?.length) {
        window.showDenioAlert("No workout data found. Start from homepage.");
        setTimeout(() => {
            window.location.href = "homepage.html";
        }, 900);
        return;
    }

    const sessionMeta = activeSession.meta;
    const sessionState = activeSession.state;
    if (sessionMeta.schedule_date && sessionMeta.schedule_date !== getAppDateKey()) {
        localStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem(SESSION_META_KEY);
        window.showDenioAlert("That workout day has reset. Please start today's scheduled workout from the homepage.");
        setTimeout(() => {
            window.location.href = "homepage.html";
        }, 1000);
        return;
    }
    sessionState.rest = sessionState.rest || null;
    sessionState.coachHistory = sessionState.coachHistory || [];

    let stopWatchInterval = null;
    let restInterval = null;
    let pendingAfterRestAction = null;
    let exerciseSyncReady = false;

    function saveState() {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(activeSession));
    }

    function getCurrentExercise() {
        return sessionMeta.exercises[sessionState.currentExerciseIndex];
    }

    function syncLatestExerciseData(snapshot) {
        const byId = new Map();
        const byName = new Map();
        snapshot.forEach((docSnap) => {
            const data = { id: docSnap.id, ...docSnap.data() };
            byId.set(docSnap.id, data);
            byName.set(String(data.name || "").toLowerCase(), data);
        });
        const syncedExercises = sessionMeta.exercises.map((exercise) => {
            const latest = byId.get(exercise.exercise_id || exercise.id) || byName.get(String(exercise.name || "").toLowerCase());
            if (!latest) return { ...exercise, deletedFromLibrary: true };
            return {
                ...exercise,
                name: latest.name || exercise.name,
                description: latest.description || latest.instructions || exercise.description,
                form_tips: latest.form_tips || latest.advice || exercise.form_tips,
                gif_url: latest.gif_url || latest.image_url || latest.image || exercise.gif_url,
                equipment: latest.equipment || latest.equipment_needed || exercise.equipment,
                muscle_group: latest.muscle_group || latest.primary_muscle || exercise.muscle_group
            };
        });
        const availableExercises = syncedExercises.filter((exercise) => !exercise.deletedFromLibrary);
        if (availableExercises.length) {
            sessionMeta.exercises = availableExercises;
            sessionState.currentExerciseIndex = Math.min(sessionState.currentExerciseIndex, sessionMeta.exercises.length - 1);
        } else {
            sessionMeta.exercises = syncedExercises;
        }
        saveState();
        if (exerciseSyncReady && !sessionState.rest) renderExercise();
        exerciseSyncReady = true;
    }

    function getSetId(exercise, setIndex) {
        return `${exercise.id}-set-${setIndex + 1}`;
    }

    function getUnfinishedSetIds(exercise) {
        const unfinished = [];
        for (let i = 0; i < exercise.sets; i++) {
            const setId = getSetId(exercise, i);
            if (!sessionState.completedSetIds.includes(setId)) unfinished.push(setId);
        }
        return unfinished;
    }

    function getNextSetIndex(exercise) {
        for (let i = 0; i < exercise.sets; i++) {
            if (!sessionState.completedSetIds.includes(getSetId(exercise, i))) return i;
        }
        return Math.max(0, exercise.sets - 1);
    }

    function recalculateTotals() {
        let totalVolume = 0;
        let maxWeight = 0;
        let completedSets = 0;

        Object.entries(sessionState.setLogs).forEach(([setId, log]) => {
            const reps = Number(log.reps) || 0;
            const weight = Number(log.weight) || 0;
            totalVolume += reps * weight;
            maxWeight = Math.max(maxWeight, weight);
            if (sessionState.completedSetIds.includes(setId)) completedSets += 1;
        });

        sessionState.totalVolume = Math.round(totalVolume);
        sessionState.maxWeight = maxWeight;
        sessionState.completedSets = completedSets;
    }

    function pickCoachLine(poolName) {
        const pool = coachJayPools[poolName] || coachJayPools.motivational;
        const history = sessionState.coachHistory;
        const recent = history.slice(-3);
        const candidates = pool.filter((line) => !recent.includes(line));
        const source = candidates.length ? candidates : pool;
        const line = source[Math.floor(Math.random() * source.length)];
        history.push(line);
        if (history.length > 20) history.shift();
        return line;
    }

    function getCoachMessage(stage) {
        const exercise = getCurrentExercise();
        const progress = (sessionState.currentExerciseIndex + 1) / sessionMeta.exercises.length;
        const exerciseType = getExerciseTypeFromRepRange(exercise);
        const isFatigueStage = progress >= 0.65 || sessionState.currentSetIndex >= Math.max(1, exercise.sets - 2);
        let context = `${exercise.muscle_group || sessionMeta.muscle_group} day. ${exerciseType.toUpperCase()} block.`;
        if (exercise.is_focus) context += " Focus lift coming up.";
        if (isFatigueStage) context += " Fatigue stage activated.";
        const messageContext = stage === "exercise" ? "exercise" : "session";
        return `${context} ${buildCoachJayMessage({
            context: messageContext,
            muscleGroup: exercise.muscle_group || sessionMeta.muscle_group,
            signals: { fatigueScore: isFatigueStage ? 0.45 : 0.1 }
        })}`;
    }

    function renderMedia(exercise) {
        if (!dom.mediaContainer) return;
        const gifUrl = exercise.gif_url || "";
        if (!gifUrl) {
            if (dom.mediaPlaceholder) {
                dom.mediaPlaceholder.style.display = "block";
                dom.mediaPlaceholder.innerText = "[ Exercise GIF / Visuals ]";
            }
            const oldImg = document.getElementById("sessionExerciseGif");
            if (oldImg) oldImg.remove();
            return;
        }

        let mediaImg = document.getElementById("sessionExerciseGif");
        if (!mediaImg) {
            mediaImg = document.createElement("img");
            mediaImg.id = "sessionExerciseGif";
            mediaImg.style.width = "100%";
            mediaImg.style.height = "100%";
            mediaImg.style.objectFit = "contain";
            mediaImg.style.borderRadius = "0";
            dom.mediaContainer.prepend(mediaImg);
        }

        mediaImg.src = gifUrl;
        mediaImg.alt = exercise.name;
        mediaImg.onerror = () => {
            mediaImg.remove();
            if (dom.mediaPlaceholder) {
                dom.mediaPlaceholder.style.display = "block";
                dom.mediaPlaceholder.innerText = "[ Exercise GIF / Visuals ]";
            }
        };
        if (dom.mediaPlaceholder) dom.mediaPlaceholder.style.display = "none";
    }

    function renderSetUI() {
        const exercise = getCurrentExercise();
        const repData = parseRepRange(exercise.rep_range || exercise.reps);
        const showWeight = hasExternalLoad(exercise);
        sessionState.currentSetIndex = getNextSetIndex(exercise);
        dom.setsWrapper.innerHTML = "";

        for (let i = 0; i < exercise.sets; i++) {
            const setId = getSetId(exercise, i);
            const isDone = sessionState.completedSetIds.includes(setId);
            const isActive = i === sessionState.currentSetIndex && !isDone;
            const setLog = sessionState.setLogs[setId] || { weight: "", reps: repData.avg };

            const setItem = document.createElement("div");
            setItem.className = `set-item ${isDone ? "done" : ""} ${isActive ? "active" : ""}`;
            setItem.innerHTML = `
                <div>
                    <div class="set-label">Set ${i + 1}</div>
                    <div class="set-details">${repData.min}-${repData.max} reps${isDone ? " • complete" : isActive ? " • active" : ""}</div>
                </div>
                <div style="display:flex; align-items:center; gap:8px;">
                    ${showWeight ? `<input
                        type="number"
                        min="0"
                        step="0.5"
                        value="${setLog.weight}"
                        data-setid="${setId}"
                        class="set-weight-input"
                        placeholder="lbs"
                        style="width:70px; background:#111; border:1px solid #444; color:#fff; border-radius:6px; padding:6px;"
                        ${isDone ? "disabled" : ""}
                    />` : `<span style="font-size:12px; color:#999;">No weight</span>`}
                </div>
            `;
            dom.setsWrapper.appendChild(setItem);
        }

        dom.setsWrapper.querySelectorAll(".set-weight-input").forEach((input) => {
            input.addEventListener("input", (event) => {
                const setId = event.target.dataset.setid;
                if (!sessionState.setLogs[setId]) sessionState.setLogs[setId] = { weight: "", reps: repData.avg };
                sessionState.setLogs[setId].weight = event.target.value;
                recalculateTotals();
                saveState();
            });
        });
    }

    function updateNextButtonLabel() {
        const exercise = getCurrentExercise();
        const remainingSets = getUnfinishedSetIds(exercise);
        if (remainingSets.length === 0 && sessionState.currentExerciseIndex === sessionMeta.exercises.length - 1) {
            dom.actionBtn.innerText = "COMPLETE WORKOUT";
            return;
        }
        dom.actionBtn.innerText = remainingSets.length === 0 ? "NEXT EXERCISE" : "NEXT";
    }

    function renderExercise() {
        let exercise = getCurrentExercise();
        if (!exercise?.name || exercise.name === "Unknown Exercise") {
            sessionMeta.exercises = sessionMeta.exercises.filter((item) => item?.name && item.name !== "Unknown Exercise");
            if (!sessionMeta.exercises.length) {
                window.showDenioAlert("No valid exercises are available for this session.");
                setTimeout(() => window.location.href = "homepage.html", 900);
                return;
            }
            sessionState.currentExerciseIndex = Math.min(sessionState.currentExerciseIndex, sessionMeta.exercises.length - 1);
            exercise = getCurrentExercise();
        }
        dom.progress.innerText = `${sessionState.currentExerciseIndex + 1}/${sessionMeta.exercises.length}`;
        dom.title.innerText = exercise.name;
        dom.desc.innerHTML = `
            <span>${exercise.description || "Maintain strict form and full range of motion."}</span>
            <br><span style="color:#e63946;">Tip: ${exercise.form_tips || "Control each rep and avoid rushing."}</span>
        `;
        if (dom.restCoachMsg) dom.restCoachMsg.innerText = getCoachMessage("exercise");
        renderMedia(exercise);
        renderSetUI();
        updateNextButtonLabel();
        saveState();
    }

    function updateStopwatch() {
        dom.stopwatch.innerText = formatClock(sessionState.elapsedSeconds);
    }

    function startStopwatch() {
        updateStopwatch();
        stopWatchInterval = setInterval(() => {
            if (sessionMeta.schedule_date && sessionMeta.schedule_date !== getAppDateKey()) {
                clearInterval(stopWatchInterval);
                if (restInterval) clearInterval(restInterval);
                localStorage.removeItem(STORAGE_KEY);
                localStorage.removeItem(SESSION_META_KEY);
                window.showDenioAlert("This workout day has reset. Today's schedule is ready on the homepage.");
                setTimeout(() => window.location.href = "homepage.html", 1000);
                return;
            }
            sessionState.elapsedSeconds += 1;
            updateStopwatch();
            saveState();
        }, 1000);
    }

    function setRestOverlayVisible(isVisible) {
        dom.restOverlay.style.display = isVisible ? "flex" : "none";
        dom.exerciseDetailsView.style.display = isVisible ? "none" : "flex";
        dom.coachJayView.style.display = isVisible ? "block" : "none";
    }

    function formatRestDisplay(secondsLeft) {
        const mins = String(Math.floor(secondsLeft / 60)).padStart(2, "0");
        const secs = String(secondsLeft % 60).padStart(2, "0");
        dom.restDisplay.innerText = `${mins}:${secs}`;
    }

    function injectRestControls() {
        document.getElementById("restPauseBtn")?.remove();
        document.getElementById("restResetBtn")?.remove();
    }

    function finishRestAndContinue() {
        clearInterval(restInterval);
        restInterval = null;
        sessionState.rest = null;
        setRestOverlayVisible(false);
        dom.actionBtn.disabled = false;
        if (pendingAfterRestAction) pendingAfterRestAction();
        pendingAfterRestAction = null;
        updateNextButtonLabel();
        saveState();
    }

    function startRestTimer(seconds, callback) {
        pendingAfterRestAction = callback;
        sessionState.rest = {
            totalSeconds: seconds,
            remainingSeconds: seconds,
            isPaused: false
        };
        dom.actionBtn.disabled = true;
        dom.actionBtn.innerText = "RESTING...";
        if (dom.restCoachMsg) dom.restCoachMsg.innerText = getCoachMessage("rest");
        setRestOverlayVisible(true);
        injectRestControls();
        formatRestDisplay(sessionState.rest.remainingSeconds);
        saveState();

        restInterval = setInterval(() => {
            if (!sessionState.rest || sessionState.rest.isPaused) return;
            sessionState.rest.remainingSeconds -= 1;
            formatRestDisplay(Math.max(0, sessionState.rest.remainingSeconds));
            if (sessionState.rest.remainingSeconds <= 0) finishRestAndContinue();
            saveState();
        }, 1000);
    }

    function resumeRestIfNeeded() {
        if (!sessionState.rest) return;
        pendingAfterRestAction = () => {};
        setRestOverlayVisible(true);
        injectRestControls();
        formatRestDisplay(sessionState.rest.remainingSeconds);
        dom.actionBtn.disabled = true;
        dom.actionBtn.innerText = "RESTING...";
        restInterval = setInterval(() => {
            if (!sessionState.rest || sessionState.rest.isPaused) return;
            sessionState.rest.remainingSeconds -= 1;
            formatRestDisplay(Math.max(0, sessionState.rest.remainingSeconds));
            if (sessionState.rest.remainingSeconds <= 0) finishRestAndContinue();
            saveState();
        }, 1000);
    }

    async function completeWorkout() {
        clearInterval(stopWatchInterval);
        if (restInterval) clearInterval(restInterval);

        recalculateTotals();
        const totalCompletedSets = sessionState.completedSetIds.length;
        let totalReps = 0;

        Object.entries(sessionState.setLogs).forEach(([setId, log]) => {
            if (!sessionState.completedSetIds.includes(setId)) return;
            totalReps += Number(log.reps) || 0;
        });

        const durationMinutes = Math.max(1, Math.round(sessionState.elapsedSeconds / 60));
        const caloriesBurned = Math.round((durationMinutes * 5) + (sessionState.totalVolume / 120));
        const durationLabel = formatClock(sessionState.elapsedSeconds);

        const safeSessionDayNumber = normalizeLiftDayNumber(sessionMeta.workout_day_number || sessionMeta.day_number || trueCurrentAppDay, 1);
        const summaryPayload = {
            user_id: user.uid,
            workout_day: sessionMeta.workout_day,
            workout_label: isValidLiftDayNumber(safeSessionDayNumber)
                ? formatWorkoutDayLabel(safeSessionDayNumber)
                : (sessionMeta.workout_label || "Workout Day"),
            muscle_group: sessionMeta.muscle_group,
            schedule_date: sessionMeta.schedule_date || getAppDateKey(),
            timezone: sessionMeta.timezone || APP_TIME_ZONE,
            total_sets: totalCompletedSets,
            total_reps: totalReps,
            total_weight_lifted: sessionState.totalVolume,
            max_weight: sessionState.maxWeight,
            duration_seconds: sessionState.elapsedSeconds,
            duration_label: durationLabel,
            calories_burned_est: caloriesBurned,
            exercises: sessionMeta.exercises,
            set_logs: sessionState.setLogs
        };

        try {
            const completedDayNumber = normalizeLiftDayNumber(sessionMeta.workout_day_number || sessionMeta.day_number || trueCurrentAppDay, 1);
            const schedule = {
                isScheduled: true,
                statusId: `${summaryPayload.schedule_date}_workout`,
                dateKey: summaryPayload.schedule_date,
                timezone: summaryPayload.timezone,
                workoutDayNumber: completedDayNumber,
                calendarDayNumber: Number(sessionMeta.calendar_day_number) || completedDayNumber
            };
            const result = await completeScheduledWorkout({
                userId: user.uid,
                schedule,
                summaryPayload
            });

            if (!result.duplicate) {
                await setDoc(doc(db, "users", user.uid), {
                    completedDays: arrayUnion(completedDayNumber),
                    completedWorkoutLabels: arrayUnion(summaryPayload.workout_label || formatWorkoutDayLabel(completedDayNumber)),
                    completedWorkoutCount: increment(1),
                    lastWorkoutCompletedAt: serverTimestamp(),
                    lastWorkoutCompletedAtIso: new Date().toISOString(),
                    lastWorkoutCompletedDate: summaryPayload.schedule_date,
                    lastCompletedWorkoutDay: completedDayNumber
                }, { merge: true });
                createAdminNotification("workout_completed", {
                    uid: user.uid,
                    email: user.email,
                    name: user.displayName || user.email
                }, {
                    workout_day: summaryPayload.workout_day,
                    muscle_group: summaryPayload.muscle_group,
                    duration_seconds: summaryPayload.duration_seconds
                });
            } else {
                console.warn("Duplicate workout completion ignored for day:", completedDayNumber);
            }
        } catch (error) {
            console.error("Failed to save workout completion:", error);
            window.showDenioAlert(error?.message || "This workout could not be completed.");
            setTimeout(() => {
                localStorage.removeItem(STORAGE_KEY);
                window.location.href = "homepage.html";
            }, 1000);
            return;
        }

        localStorage.setItem("denio_last_duration", durationLabel);
        localStorage.setItem("denio_last_session_stats", JSON.stringify(summaryPayload));
        localStorage.removeItem(STORAGE_KEY);
        window.location.href = "result-page.html";
    }

    function transitionToNextExercise() {
        const exercise = getCurrentExercise();
        if (sessionState.currentExerciseIndex >= sessionMeta.exercises.length - 1) {
            completeWorkout();
            return;
        }

        dom.wrapper.style.transform = "translateX(-100%)";
        setTimeout(() => {
            sessionState.currentExerciseIndex += 1;
            sessionState.currentSetIndex = 0;
            renderExercise();
            dom.wrapper.style.transition = "none";
            dom.wrapper.style.transform = "translateX(100%)";
            setTimeout(() => {
                dom.wrapper.style.transition = "transform 0.45s cubic-bezier(0.25, 1, 0.5, 1)";
                dom.wrapper.style.transform = "translateX(0)";
            }, 50);
        }, 400);
    }

    window.processNextAction = function processNextAction() {
        if (sessionState.rest) return;
        const exercise = getCurrentExercise();
        const setId = getSetId(exercise, sessionState.currentSetIndex);
        const repData = parseRepRange(exercise.rep_range || exercise.reps);
        const requiresWeight = hasExternalLoad(exercise);
        const weightInput = dom.setsWrapper.querySelector(`.set-weight-input[data-setid="${setId}"]`);
        const enteredWeight = String(weightInput?.value ?? sessionState.setLogs[setId]?.weight ?? "").trim();

        if (requiresWeight && enteredWeight === "") {
            window.showDenioAlert("Enter the weight used for this set before continuing.");
            return;
        }

        if (!sessionState.completedSetIds.includes(setId)) sessionState.completedSetIds.push(setId);
        if (!sessionState.setLogs[setId]) sessionState.setLogs[setId] = { weight: "", reps: repData.avg };
        if (requiresWeight) sessionState.setLogs[setId].weight = enteredWeight;
        if (!sessionState.setLogs[setId].reps) sessionState.setLogs[setId].reps = repData.avg;

        recalculateTotals();
        renderSetUI();
        saveState();

        sessionState.currentSetIndex = getNextSetIndex(exercise);
        const unfinished = getUnfinishedSetIds(exercise);
        if (unfinished.length === 0) {
            if (sessionState.currentExerciseIndex >= sessionMeta.exercises.length - 1) {
                completeWorkout();
                return;
            }
            const restSeconds = calculateRecommendedRest(exercise);
            startRestTimer(restSeconds, transitionToNextExercise);
            return;
        }

        const restSeconds = calculateRecommendedRest(exercise);
        startRestTimer(restSeconds, () => {
            sessionState.currentSetIndex = getNextSetIndex(exercise);
            renderSetUI();
        });
    };

    renderExercise();
    startStopwatch();
    resumeRestIfNeeded();
    onSnapshot(collection(db, "exercises"), syncLatestExerciseData);
}
