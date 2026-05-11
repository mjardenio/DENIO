import { db } from "./firebase.js";
import {
    addDoc,
    collection,
    doc,
    getDocs,
    limit,
    orderBy,
    query,
    serverTimestamp,
    updateDoc,
    where
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { buildCoachJayMessage, regenerateFutureWorkoutPlan, LEVEL_SCALING } from "./adaptive-engine.js";
import { formatWorkoutDayLabel, normalizeLiftDayNumber } from "./schedule-engine.js";

const PROGRESSION_RESPONSE_MAP = {
    easy: "I can do more",
    perfect: "It feels enough",
    hard: "It's too much"
};

function getSessionStatsFromStorage() {
    const duration = localStorage.getItem("denio_last_duration") || "00:00:00";
    const raw = localStorage.getItem("denio_last_session_stats");
    if (!raw) return { duration, stats: null };
    try {
        return { duration, stats: JSON.parse(raw) };
    } catch (error) {
        console.error("Failed to parse latest session stats:", error);
        return { duration, stats: null };
    }
}

function renderWorkoutSummary(stats, durationLabel) {
    const container = document.querySelector(".stats-container");
    if (!container || !stats) return;

    const rows = [
        ["Total Workout Duration", durationLabel || "00:00:00"],
        ["Total Sets Completed", String(stats.total_sets || 0)],
        ["Max Weight Lifted", `${stats.max_weight || 0} lbs`],
        ["Estimated Calories", `${stats.calories_burned_est || 0} kcal`]
    ];

    container.innerHTML = rows
        .map(([label, value]) => `
            <div class="stat-row">
                <span>${label}</span>
                <span class="stat-value">${value}</span>
            </div>
        `)
        .join("");
}

function renderCoachMessage(stats, userData = {}) {
    const target = document.getElementById("resultCoachMsg");
    if (!target) return;

    target.innerText = buildCoachJayMessage({
        context: "result",
        userData,
        muscleGroup: stats?.muscle_group || "today's"
    }).split(".").slice(0, 2).join(".").trim() + ".";
}

function getGoalBias(userData) {
    const goals = (userData?.goals || []).map((goal) => String(goal).toLowerCase());
    if (goals.some((goal) => goal.includes("strength") || goal.includes("muscle"))) return "strength";
    if (goals.some((goal) => goal.includes("fat") || goal.includes("weight"))) return "fat_loss";
    return "general";
}

function getLevelFactor(userData) {
    const level = String(userData?.fitnessLevel || userData?.level || "beginner").toLowerCase();
    if (level.includes("advanced")) return LEVEL_SCALING.advanced.progression;
    if (level.includes("intermediate")) return LEVEL_SCALING.intermediate.progression;
    return LEVEL_SCALING.beginner.progression;
}

function getLevelKey(userData) {
    const level = String(userData?.fitnessLevel || userData?.level || "beginner").toLowerCase();
    if (level.includes("advanced")) return "advanced";
    if (level.includes("intermediate")) return "intermediate";
    return "beginner";
}

function computeAdaptiveAdjustment({ responseValue, stats, userData, easyHistoryCount, hardHistoryCount }) {
    const goalBias = getGoalBias(userData);
    const levelFactor = getLevelFactor(userData);
    const muscleGroup = stats?.muscle_group || "General";
    const baseExerciseCount = stats?.exercises?.length || 0;

    const adjustment = {
        response: responseValue,
        progression_mode: "maintain",
        rep_delta_percent: 0,
        set_delta_percent: 0,
        weight_recommendation_delta_percent: 0,
        add_optional_exercise: false,
        recommended_exercise_delta: 0,
        triggered_regeneration: false,
        consecutive_easy_count: easyHistoryCount,
        consecutive_hard_count: hardHistoryCount,
        user_goal_bias: goalBias,
        level_factor: levelFactor,
        muscle_group: muscleGroup
    };

    if (responseValue === "easy") {
        adjustment.progression_mode = "increase";
        adjustment.rep_delta_percent = Math.round(3 * levelFactor);
        adjustment.set_delta_percent = getLevelKey(userData) === "advanced" ? 1 : 0;
        adjustment.weight_recommendation_delta_percent = goalBias === "strength" ? Math.round(4 * levelFactor) : Math.round(2 * levelFactor);
        adjustment.add_optional_exercise = baseExerciseCount <= LEVEL_SCALING[getLevelKey(userData)].maxExercises;
        adjustment.recommended_exercise_delta = adjustment.add_optional_exercise ? 1 : 0;
    } else if (responseValue === "hard") {
        adjustment.progression_mode = "decrease";
        adjustment.rep_delta_percent = -Math.round(4 * levelFactor);
        adjustment.set_delta_percent = getLevelKey(userData) === "beginner" ? 0 : -1;
        adjustment.weight_recommendation_delta_percent = -Math.round(5 * levelFactor);
        adjustment.add_optional_exercise = false;
    }

    if (easyHistoryCount >= 3 && responseValue === "easy") {
        adjustment.triggered_regeneration = true;
        adjustment.progression_mode = getLevelKey(userData) === "advanced" ? "advanced_regenerate" : "increase_intensity";
        adjustment.rep_delta_percent += Math.round(4 * levelFactor);
        adjustment.set_delta_percent += getLevelKey(userData) === "beginner" ? 0 : 1;
        adjustment.weight_recommendation_delta_percent += Math.round(3 * levelFactor);
        adjustment.add_optional_exercise = true;
        adjustment.recommended_exercise_delta = 1;
    }

    if (hardHistoryCount >= 3 && responseValue === "hard") {
        adjustment.progression_mode = "deload";
        adjustment.rep_delta_percent -= 4;
        adjustment.set_delta_percent -= 2;
        adjustment.weight_recommendation_delta_percent -= 4;
        adjustment.add_optional_exercise = false;
        adjustment.recommended_exercise_delta = -1;
        adjustment.triggered_deload = true;
    }

    return adjustment;
}

function createLoadingOverlay() {
    if (document.getElementById("resultLoadingOverlay")) return;
    const overlay = document.createElement("div");
    overlay.id = "resultLoadingOverlay";
    overlay.style.position = "fixed";
    overlay.style.inset = "0";
    overlay.style.background = "rgba(0, 0, 0, 0.78)";
    overlay.style.display = "none";
    overlay.style.alignItems = "center";
    overlay.style.justifyContent = "center";
    overlay.style.zIndex = "999";
    overlay.innerHTML = `
        <div style="background:#111; color:#fff; border:1px solid #e63946; border-radius:12px; padding:18px 22px; font-weight:700;">
            Logging workout...
        </div>
    `;
    document.body.appendChild(overlay);
}

function setLoadingOverlayVisible(isVisible) {
    const overlay = document.getElementById("resultLoadingOverlay");
    if (!overlay) return;
    overlay.style.display = isVisible ? "flex" : "none";
}

async function getConsecutiveResponseCount(userId, muscleGroup, responseValue) {
    try {
        const logsRef = collection(db, "progression_logs");
        const q = query(
            logsRef,
            where("user_id", "==", userId),
            where("muscle_group", "==", muscleGroup),
            orderBy("created_at", "desc"),
            limit(8)
        );
        const snap = await getDocs(q);
        let count = 0;
        for (const docSnap of snap.docs) {
            const data = docSnap.data();
            if (data.response !== responseValue) break;
            count += 1;
        }
        return count + 1;
    } catch (error) {
        console.error("Failed to fetch progression history:", error);
        return 1;
    }
}

export function initResultEngine({ user, userData, trueCurrentAppDay }) {
    const finishBtn = document.getElementById("finishBtn");
    if (!finishBtn) return;

    const { duration, stats } = getSessionStatsFromStorage();
    if (duration) {
        const durationEl = document.querySelector(".duration-display");
        if (durationEl) durationEl.innerText = `Duration: ${duration}`;
    }
    renderWorkoutSummary(stats, duration);
    renderCoachMessage(stats, userData);
    createLoadingOverlay();

    let selectedSurveyResponse = null;

    window.handleSurvey = function handleSurvey(element, responseValue) {
        document.querySelectorAll(".survey-btn").forEach((btn) => btn.classList.remove("selected"));
        element.classList.add("selected");
        selectedSurveyResponse = responseValue;
        finishBtn.disabled = false;
    };

    window.finishSession = async function finishSession() {
        if (!selectedSurveyResponse) return;
        finishBtn.disabled = true;
        setLoadingOverlayVisible(true);

        const responseLabel = PROGRESSION_RESPONSE_MAP[selectedSurveyResponse] || selectedSurveyResponse;
        const muscleGroup = stats?.muscle_group || "General";
        const fallbackWorkoutDay = formatWorkoutDayLabel(normalizeLiftDayNumber(stats?.workout_day_number || stats?.day_number || trueCurrentAppDay, 1));
        const [consecutiveEasyCount, consecutiveHardCount] = await Promise.all([
            getConsecutiveResponseCount(user.uid, muscleGroup, "easy"),
            getConsecutiveResponseCount(user.uid, muscleGroup, "hard")
        ]);
        const adjustment = computeAdaptiveAdjustment({
            responseValue: selectedSurveyResponse,
            stats,
            userData,
            easyHistoryCount: consecutiveEasyCount,
            hardHistoryCount: consecutiveHardCount
        });

        const surveyPayload = {
            user_id: user.uid,
            workout_day: stats?.workout_day || fallbackWorkoutDay,
            muscle_group: muscleGroup,
            response: selectedSurveyResponse,
            response_label: responseLabel,
            duration_seconds: stats?.duration_seconds || 0,
            total_sets: stats?.total_sets || 0,
            total_reps: stats?.total_reps || 0,
            total_volume: stats?.total_weight_lifted || 0,
            created_at: serverTimestamp()
        };

        const adjustmentPayload = {
            user_id: user.uid,
            workout_day: stats?.workout_day || fallbackWorkoutDay,
            muscle_group: muscleGroup,
            progression_mode: adjustment.progression_mode,
            rep_delta_percent: adjustment.rep_delta_percent,
            set_delta_percent: adjustment.set_delta_percent,
            weight_recommendation_delta_percent: adjustment.weight_recommendation_delta_percent,
            add_optional_exercise: adjustment.add_optional_exercise,
            recommended_exercise_delta: adjustment.recommended_exercise_delta,
            triggered_regeneration: adjustment.triggered_regeneration,
            triggered_deload: Boolean(adjustment.triggered_deload),
            based_on_goal: adjustment.user_goal_bias,
            based_on_level_factor: adjustment.level_factor,
            created_at: serverTimestamp()
        };

        const progressionPayload = {
            user_id: user.uid,
            workout_day: stats?.workout_day || fallbackWorkoutDay,
            muscle_group: muscleGroup,
            response: selectedSurveyResponse,
            consecutive_easy_count: adjustment.consecutive_easy_count,
            consecutive_hard_count: adjustment.consecutive_hard_count,
            triggered_regeneration: adjustment.triggered_regeneration,
            triggered_deload: Boolean(adjustment.triggered_deload),
            progression_mode: adjustment.progression_mode,
            workout_history_snapshot: {
                duration_seconds: stats?.duration_seconds || 0,
                total_sets: stats?.total_sets || 0,
                total_reps: stats?.total_reps || 0,
                max_weight: stats?.max_weight || 0
            },
            created_at: serverTimestamp()
        };

        try {
            await addDoc(collection(db, "survey_responses"), surveyPayload);
            await addDoc(collection(db, "workout_adjustments"), adjustmentPayload);
            await addDoc(collection(db, "progression_logs"), progressionPayload);

            // Persist pending adaptive instructions for upcoming planning logic.
            await updateDoc(doc(db, "users", user.uid), {
                latestSurveyResponse: selectedSurveyResponse,
                pendingProgressionAdjustment: {
                    ...adjustment,
                    updated_at_iso: new Date().toISOString()
                }
            });

            if (adjustment.triggered_regeneration) {
                await regenerateFutureWorkoutPlan(user.uid, {
                    ...userData,
                    latestSurveyResponse: selectedSurveyResponse,
                    pendingProgressionAdjustment: adjustment
                }, {
                    currentDayNumber: trueCurrentAppDay
                });
                await updateDoc(doc(db, "users", user.uid), {
                    regenerationRequested: true,
                    regenerationContext: {
                        reason: adjustment.progression_mode,
                        muscle_group: muscleGroup,
                        requested_at_iso: new Date().toISOString()
                    }
                });
            }

            if (adjustment.triggered_deload) {
                await regenerateFutureWorkoutPlan(user.uid, {
                    ...userData,
                    latestSurveyResponse: selectedSurveyResponse,
                    pendingProgressionAdjustment: adjustment
                }, {
                    currentDayNumber: trueCurrentAppDay
                });
                await updateDoc(doc(db, "users", user.uid), {
                    deloadRequested: true,
                    deloadContext: {
                        reason: "repeated_too_much_feedback",
                        muscle_group: muscleGroup,
                        requested_at_iso: new Date().toISOString()
                    }
                });
            }
        } catch (error) {
            console.error("Error persisting post-workout feedback:", error);
        } finally {
            setLoadingOverlayVisible(false);
            window.location.href = "homepage.html";
        }
    };
}
