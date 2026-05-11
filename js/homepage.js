// js/homepage.js
import { auth, db } from "./firebase.js";
import { collection, doc, getDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { extendWorkoutPlanIfNeeded } from "./adaptive-engine.js";
import {
    fetchWorkoutStatuses,
    formatWorkoutDayLabel,
    getAppDateKey,
    getMaxScheduledWorkoutNumber,
    getRoutineDayForSchedule,
    getUpcomingSchedule,
    isValidLiftDayNumber,
    normalizeLiftDayNumber,
    reconcileWorkoutProgression
} from "./schedule-engine.js";

document.addEventListener('DOMContentLoaded', () => {
    document.body.style.overflow = 'hidden';
    const daysContainer = document.getElementById('daysContainer');
    const workoutTitle = document.getElementById('workoutTitle');
    const focusSubtitle = document.getElementById('focusSubtitle');
    const exerciseList = document.getElementById('exerciseList');
    const startBtn = document.getElementById('startSessionBtn');
    const disabledBtn = document.getElementById('disabledSessionBtn'); // 🔥 NEW: The gray button

    let currentRoutine = [];
    let currentDayIndex = 0; 
    let renderedDateKey = getAppDateKey();
    let selectedDayData = null;
    let selectedSchedule = null;
    let selectedStatus = null;
    let selectedIndex = 0;
    let selectedDayAbsoluteName = '';
    let selectedDayLabel = '';
    let exerciseCatalog = new Map();
    let exerciseCatalogReady = false;
    let statusMap = new Map();

    function normalizeExerciseData(raw, fallback = {}) {
        const name = String(raw?.name || fallback.name || "").trim();
        if (!name || name === "Unknown Exercise") return null;
        return {
            ...fallback,
            ...raw,
            id: raw?.id || raw?.exercise_id || fallback.id,
            name,
            muscle_group: raw?.muscle_group || raw?.primary_muscle || fallback.muscle_group,
            gif_url: raw?.gif_url || raw?.image_url || raw?.image || fallback.gif_url || "",
            description: raw?.description || raw?.instructions || fallback.description || "Maintain strict form and full range of motion.",
            form_tips: raw?.form_tips || raw?.advice || fallback.form_tips || "Control each rep and keep your body stable.",
            equipment: raw?.equipment || raw?.equipment_needed || fallback.equipment || fallback.equipment_needed || []
        };
    }

    function mergeLatestExercise(exercise) {
        const byId = exerciseCatalog.get(exercise.exercise_id) || exerciseCatalog.get(exercise.id);
        const byName = exerciseCatalog.get(String(exercise.name || "").toLowerCase());
        const latest = byId || byName;
        if (exerciseCatalogReady && !latest) return null;
        return normalizeExerciseData(latest || {}, exercise);
    }

    onSnapshot(collection(db, "exercises"), (snapshot) => {
        exerciseCatalog = new Map();
        snapshot.forEach((docSnap) => {
            const data = normalizeExerciseData({ id: docSnap.id, ...docSnap.data() });
            if (!data) return;
            exerciseCatalog.set(docSnap.id, data);
            exerciseCatalog.set(String(data.name || "").toLowerCase(), data);
        });
        exerciseCatalogReady = true;
        if (selectedDayData) renderWorkout(selectedDayData, selectedIndex);
    });

    onAuthStateChanged(auth, async (user) => {
        if (user) {
            try {
                const userDoc = await getDoc(doc(db, "users", user.uid));
                const userData = userDoc.exists() ? userDoc.data() : {};
                const planDoc = await getDoc(doc(db, "workout_plans", user.uid));
                
                if (planDoc.exists()) {
                    let planData = planDoc.data();
                    let fetchedRoutine = planData.routine;
                    currentDayIndex = 0;

                    const progressionState = await reconcileWorkoutProgression(user.uid, userData, planData, { allowResetSkip: true });
                    const reconciledUserData = {
                        ...userData,
                        currentLiftDay: progressionState.currentLiftDay,
                        currentWeekday: progressionState.currentWeekday,
                        workoutStatus: progressionState.workoutStatus,
                        progressionStartDate: progressionState.progressionStartDate || userData.progressionStartDate
                    };
                    renderedDateKey = getAppDateKey();
                    const schedules = getUpcomingSchedule(reconciledUserData, planData, 7, renderedDateKey, progressionState, progressionState.statusByDate);
                    const maxWorkoutDay = getMaxScheduledWorkoutNumber(schedules);

                    if ((fetchedRoutine || []).length < maxWorkoutDay) {
                        if (exerciseList) exerciseList.innerHTML = '<div style="color: #aaa; text-align:center; padding: 20px;">DENIO is adapting your next workout cycle...</div>';
                        planData = await extendWorkoutPlanIfNeeded(user.uid, reconciledUserData, maxWorkoutDay) || planData;
                        fetchedRoutine = planData.routine || fetchedRoutine;
                    }

                    statusMap = await fetchWorkoutStatuses(user.uid, schedules);
                    currentRoutine = schedules.map((schedule) => ({
                        ...getRoutineDayForSchedule({ ...planData, routine: fetchedRoutine }, schedule),
                        schedule,
                        status: statusMap.get(schedule.statusId)?.status || (schedule.isScheduled ? "pending" : "rest")
                    }));
                    
                    renderDays(currentRoutine);
                    renderWorkout(currentRoutine[currentDayIndex], currentDayIndex); 
                } else {
                    if(exerciseList) exerciseList.innerHTML = '<div style="color: #aaa; text-align:center; padding: 20px;">No workout plan found. Please set up your profile.</div>';
                    if(workoutTitle) workoutTitle.innerText = "NO PLAN YET";
                    if(focusSubtitle) focusSubtitle.innerText = "";
                    if(startBtn) startBtn.style.display = 'none';
                    if(disabledBtn) disabledBtn.style.display = 'none';
                }
            } catch (error) {
                console.error("Error fetching plan:", error);
                if(exerciseList) exerciseList.innerHTML = '<div style="color: #e63946; text-align:center;">Failed to load plan. Check connection.</div>';
            }
        } else {
            window.location.href = '../profile/login.html'; 
        }
    });

    function renderDays(routine) {
        if (!daysContainer) return;
        daysContainer.innerHTML = ''; 

        routine.forEach((day, index) => {
            const label = day?.schedule?.isScheduled
                ? formatWorkoutDayLabel(day.schedule.workoutDayNumber)
                : "Rest Day";
            const btn = document.createElement('button');
            btn.className = index === currentDayIndex ? 'day-btn active' : 'day-btn';
            btn.innerText = label;
            
            // 🔥 TWEAK 1: Give the *Actual* Current Day a permanent highlight border!
            if (index === currentDayIndex) {
                btn.style.border = "2px solid #e63946"; 
                btn.style.fontWeight = "bold";
            }
            if (day.status === "completed") btn.classList.add('completed');
            
            btn.onclick = () => {
                document.querySelectorAll('.day-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                renderWorkout(day, index); 
            };
            
            daysContainer.appendChild(btn);
        });
    }

    function renderWorkout(dayData, index) {
        selectedIndex = index;
        let displayDayName = dayData?.schedule?.weekdayName || "TODAY";
        if (!exerciseCatalogReady) {
            selectedDayData = dayData;
            if (workoutTitle) workoutTitle.innerText = `${displayDayName} WORKOUT`;
            if (focusSubtitle) focusSubtitle.innerText = (dayData.focus_label || "Validating").toUpperCase();
            if (exerciseList) exerciseList.innerHTML = '<div style="color:#aaa; text-align:center; padding:20px;">Validating exercises from the library...</div>';
            if (startBtn) startBtn.style.display = 'none';
            if (disabledBtn) {
                disabledBtn.style.display = 'block';
                disabledBtn.innerText = 'LOADING';
            }
            return;
        }
        selectedDayData = {
            ...dayData,
            exercises: (dayData.exercises || []).map(mergeLatestExercise).filter(Boolean)
        };
        selectedSchedule = dayData.schedule;
        selectedStatus = dayData.status || (selectedSchedule?.isScheduled ? "pending" : "rest");
        selectedDayAbsoluteName = displayDayName;
        selectedDayLabel = selectedSchedule?.isScheduled ? formatWorkoutDayLabel(selectedSchedule.workoutDayNumber) : "Rest Day";
        
        if (workoutTitle) workoutTitle.innerText = `${displayDayName} WORKOUT`;
        if (focusSubtitle) focusSubtitle.innerText = (dayData.focus_label || "Rest Day").toUpperCase();
        
        if (exerciseList) {
            exerciseList.innerHTML = ''; 
            
            if (!selectedSchedule?.isScheduled || selectedDayData.exercises.length === 0) {
                // Rest Day UI
                exerciseList.innerHTML = `
                    <div style="text-align:center; padding: 40px 20px; color: #aaa; background: #1a1a1a; border-radius: 12px;">
                        <h3 style="color: white; font-size: 20px; margin: 0;">Rest & Recover</h3>
                        <p style="font-size: 13px; margin-top: 8px;">No exercises scheduled. Let your muscles rebuild!</p>
                    </div>`;
                
                // Hide Start Button, Show Disabled Button that says "REST DAY"
                if (startBtn) startBtn.style.display = 'none'; 
                if (disabledBtn) {
                    disabledBtn.style.display = 'block';
                    disabledBtn.innerText = 'REST DAY';
                }
            } else {
                // Workout Day UI
                
                // 🔥 TWEAK 2: The Gray Button Logic
                const isCompleted = selectedStatus === "completed";
                const isSkipped = selectedStatus === "skipped";
                if (isCompleted) {
                    if (startBtn) {
                        startBtn.style.display = 'block';
                        startBtn.disabled = true;
                        startBtn.innerText = 'COMPLETED';
                        startBtn.style.background = '#4CAF50';
                    }
                    if (disabledBtn) disabledBtn.style.display = 'none';
                } else if (isSkipped) {
                    if (startBtn) startBtn.style.display = 'none';
                    if (disabledBtn) {
                        disabledBtn.style.display = 'block';
                        disabledBtn.innerText = 'SESSION MISSED';
                    }
                } else if (index === currentDayIndex && selectedSchedule?.isScheduled) {
                    if (startBtn) startBtn.style.display = 'block'; 
                    if (startBtn) {
                        startBtn.disabled = false;
                        startBtn.innerText = 'START WORKOUT';
                        startBtn.style.background = '';
                    }
                    if (disabledBtn) disabledBtn.style.display = 'none'; 
                } else {
                    if (startBtn) startBtn.style.display = 'none'; 
                    if (disabledBtn) {
                        disabledBtn.style.display = 'block';
                        // If the day is in the past, it says missed. If future, it says locked.
                        disabledBtn.innerText = "SESSION LOCKED";
                    }
                }

                selectedDayData.exercises.forEach(ex => {
                    const focusTag = ex.is_focus ? `<span style="background: rgba(230, 57, 70, 0.2); color: #e63946; font-size: 10px; padding: 2px 6px; border-radius: 4px; margin-left: 8px; font-weight: bold; border: 1px solid #e63946;">FOCUS</span>` : '';
                    
                    // 🔥 TWEAK 3: Mark past days as "SKIPPED" in Gray
                    let borderColor = isCompleted ? "#4CAF50" : (isSkipped ? "#444" : "#e63946"); 
                    let statusElement = isCompleted
                        ? `<div style="color: #4CAF50; font-size: 12px; font-weight: bold; letter-spacing: 1px;">DONE</div>`
                        : isSkipped 
                        ? `<div style="color: #888; font-size: 12px; font-weight: bold; letter-spacing: 1px;">SKIPPED</div>` 
                        : `<div style="color: #444; font-size: 24px; font-weight: bold;">○</div>`;
                    
                    const card = document.createElement('div');
                    card.className = 'exercise-card'; 
                    card.style.cssText = `display: flex; align-items: center; justify-content: space-between; background: #1a1a1a; padding: 12px; border-radius: 12px; margin-bottom: 12px; border-left: 4px solid ${borderColor};`;
                    
                    card.innerHTML = `
                        <div style="display: flex; align-items: center; gap: 15px; ${isSkipped ? 'opacity: 0.5;' : ''}">
                            <img src="${ex.gif_url}" 
                                 onerror="this.onerror=null; this.src='https://ui-avatars.com/api/?name=${encodeURIComponent(ex.name)}&background=262626&color=e63946&size=150&rounded=true';"
                                 loading="lazy"
                                 style="width: 55px; height: 55px; border-radius: 8px; object-fit: contain; background: #222;">
                            <div>
                                <strong style="color: white; font-size: 14px; display: flex; align-items: center;">${ex.name} ${focusTag}</strong>
                                <div style="color: #aaa; font-size: 12px; margin-top: 4px;">${ex.sets} sets x ${ex.reps} reps</div>
                            </div>
                        </div>
                        ${statusElement}
                    `;
                    exerciseList.appendChild(card);
                });
            }
        }
        
        if (startBtn) {
            startBtn.onclick = () => {
                if (startBtn.disabled) return;
                if (!selectedSchedule?.isScheduled || !isValidLiftDayNumber(selectedSchedule.workoutDayNumber)) {
                    window.showDenioAlert("This is a rest day. Your next lifting day will appear when scheduled.");
                    return;
                }
                const sanitizedExercises = (selectedDayData?.exercises || []).map((exercise, exIndex) => {
                    const parsedSets = Number.parseInt(exercise.sets, 10);
                    return {
                        id: exercise.exercise_id || exercise.id || `${exercise.name || 'exercise'}-${exIndex + 1}`,
                        name: exercise.name,
                        description: exercise.description || "Maintain strict form and full range of motion.",
                        form_tips: exercise.form_tips || "Control the movement and avoid rushing reps.",
                        gif_url: exercise.gif_url || "",
                        sets: Number.isFinite(parsedSets) && parsedSets > 0 ? parsedSets : 3,
                        rep_range: String(exercise.reps || "8-12"),
                        reps: String(exercise.reps || "8-12"),
                        muscle_group: exercise.muscle_group || selectedDayData?.focus_label || "Full Body",
                        equipment: exercise.equipment || exercise.equipment_needed || [],
                        is_focus: Boolean(exercise.is_focus)
                    };
                });

                const totalSets = sanitizedExercises.reduce((acc, ex) => acc + ex.sets, 0);
                const estimatedDurationMinutes = Math.max(
                    20,
                    Math.round(
                        sanitizedExercises.length * 2.5 +
                        totalSets * 1.4 +
                        sanitizedExercises.length * 1.5
                    )
                );

                const allRepRanges = sanitizedExercises.map((exercise) => exercise.rep_range);
                const allSetCounts = sanitizedExercises.map((exercise) => exercise.sets);
                const allExerciseGifs = sanitizedExercises.map((exercise) => exercise.gif_url || "");

                const safeWorkoutDayNumber = normalizeLiftDayNumber(selectedSchedule.workoutDayNumber, 1);
                const sessionPayload = {
                    day_number: safeWorkoutDayNumber,
                    workout_day_number: safeWorkoutDayNumber,
                    calendar_day_number: selectedSchedule?.calendarDayNumber || null,
                    schedule_date: selectedSchedule?.dateKey || "",
                    timezone: selectedSchedule?.timezone || "Asia/Manila",
                    workout_day: selectedDayAbsoluteName,
                    workout_label: selectedDayLabel,
                    muscle_group: selectedDayData?.focus_label || "General Fitness",
                    estimated_duration_minutes: estimatedDurationMinutes,
                    set_scheme: allSetCounts,
                    rep_ranges: allRepRanges,
                    exercise_gifs: allExerciseGifs,
                    exercises: sanitizedExercises,
                    created_at: new Date().toISOString()
                };

                localStorage.setItem('current_session_data', JSON.stringify(sessionPayload));
                localStorage.setItem('denio_active_session', JSON.stringify({
                    meta: sessionPayload,
                    state: {
                        currentExerciseIndex: 0,
                        currentSetIndex: 0,
                        completedSetIds: [],
                        setLogs: {},
                        startedAt: Date.now(),
                        elapsedSeconds: 0,
                        totalVolume: 0,
                        maxWeight: 0,
                        completedSets: 0,
                        coachHistory: [],
                        rest: null
                    }
                }));
                window.location.href = 'session-page.html';
            };
        }
    }

    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible" && getAppDateKey() !== renderedDateKey) {
            window.location.reload();
        }
    });

    setInterval(() => {
        if (getAppDateKey() !== renderedDateKey) window.location.reload();
    }, 60 * 1000);
});
