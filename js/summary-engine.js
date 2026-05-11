import { db } from "./firebase.js";
import { collection, getDocs, query, where } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { buildPredictiveInsights } from "./adaptive-engine.js";
import { addDaysToDateKey, diffDateKeys, getAppDateKey, getProfileStartDateKey, getScheduleForDate, getVerifiedWorkoutLogs, getWeekdayName, getWorkoutStatusHistory } from "./schedule-engine.js";

function formatDuration(seconds) {
    const safe = Math.max(0, Number(seconds) || 0);
    const h = String(Math.floor(safe / 3600)).padStart(2, "0");
    const m = String(Math.floor((safe % 3600) / 60)).padStart(2, "0");
    const s = String(safe % 60).padStart(2, "0");
    return `${h}:${m}:${s}`;
}

function toDateSafe(value) {
    if (!value) return null;
    if (typeof value.toDate === "function") return value.toDate();
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getDateKey(dateValue) {
    if (typeof dateValue === "string" && /^\d{4}-\d{2}-\d{2}$/.test(dateValue)) return dateValue;
    const date = toDateSafe(dateValue);
    if (!date) return null;
    return getAppDateKey(date);
}

function average(values) {
    if (!values.length) return 0;
    return Math.round(values.reduce((acc, n) => acc + n, 0) / values.length);
}

function buildPredictiveAnalysis({ consistencyRate, progressionRate, fatigueTrend, completionRate }) {
    const consistencyTone = consistencyRate >= 0.75
        ? "Your consistency is excellent and supports fast adaptation."
        : consistencyRate >= 0.5
            ? "Your consistency is moderate; regular session timing can unlock faster gains."
            : "Consistency is currently low, so stabilizing your weekly routine should be priority one.";

    const progressionTone = progressionRate > 0
        ? "Performance trend is moving upward based on recent volume and max-weight progression."
        : progressionRate < 0
            ? "Performance trend dipped recently; reduce missed days and prioritize recovery quality."
            : "Performance trend is stable; progressive overload can be increased gradually.";

    const fatigueTone = fatigueTrend > 0.35
        ? "Fatigue signal is elevated from recent high difficulty responses."
        : "Fatigue signal is manageable based on current post-workout responses.";

    const completionTone = completionRate >= 0.8
        ? "Workout completion reliability is strong."
        : "Workout completion reliability has room to improve; reduce skipped sessions this week.";

    return `${consistencyTone} ${progressionTone} ${fatigueTone} ${completionTone}`;
}

function getWorkoutFrequency(userData = {}) {
    const frequency = Number.parseInt(userData.workoutFrequency || userData.frequency, 10);
    return Number.isFinite(frequency) ? Math.min(7, Math.max(1, frequency)) : 3;
}

function getScheduledDates(userData, throughDate = new Date()) {
    const startDateKey = getProfileStartDateKey(userData);
    const throughDateKey = getAppDateKey(throughDate);
    const elapsedDays = Math.max(1, diffDateKeys(startDateKey, throughDateKey) + 1);
    const dates = [];
    for (let dayNumber = 1; dayNumber <= elapsedDays; dayNumber++) {
        const dateKey = addDaysToDateKey(startDateKey, dayNumber - 1);
        const schedule = getScheduleForDate(userData, dateKey);
        if (schedule.isScheduled) dates.push(dateKey);
    }
    return dates;
}

function calculateScheduledStreak({ userData, completedKeys, skippedKeys = new Set() }) {
    const scheduled = getScheduledDates(userData).sort((a, b) => b.localeCompare(a));
    if (!scheduled.length) return 0;
    const todayKey = getDateKey(new Date());
    let streak = 0;

    for (const date of scheduled) {
        const key = getDateKey(date);
        if (skippedKeys.has(key)) break;
        if (completedKeys.has(key)) {
            streak += 1;
            continue;
        }
        if (key === todayKey && streak === 0) continue;
        break;
    }
    return streak;
}

function buildAdvancedInsightText(insights) {
    return [
        insights.progressionForecast,
        insights.plateauWarning,
        insights.fatigueLabel,
        insights.recoveryInsight,
        insights.adaptationSpeed,
        `Recommended focus area: ${insights.recommendedFocus}. Consistency score: ${insights.consistencyScore}%.`
    ].join(" ");
}

function renderWeeklyChart(container, workoutLogs, userData = {}, statusHistory = []) {
    const existing = document.getElementById("weeklyChartCard");
    if (existing) existing.remove();

    const card = document.createElement("div");
    card.id = "weeklyChartCard";
    card.className = "ai-prediction-box";
    card.innerHTML = `
        <div class="ai-header">Weekly Consistency Chart</div>
        <div id="weeklyBars" class="weekly-bars"></div>
        <div style="font-size:11px; color:#999; margin-top:8px;">Scheduled consistency this week (Monday to Sunday)</div>
    `;
    container.appendChild(card);

    const barsRoot = card.querySelector("#weeklyBars");
    const todayKey = getAppDateKey();
    const todayUtc = new Date(`${todayKey}T00:00:00Z`);
    const dayOffset = (todayUtc.getUTCDay() + 6) % 7;
    const mondayKey = addDaysToDateKey(todayKey, -dayOffset);
    const days = Array.from({ length: 7 }, (_, index) => addDaysToDateKey(mondayKey, index));
    const countsByDay = new Map();
    workoutLogs.forEach((log) => {
        const key = getDateKey(log.schedule_date || log.created_at);
        if (!key) return;
        countsByDay.set(key, (countsByDay.get(key) || 0) + 1);
    });
    const scheduledKeys = new Set(getScheduledDates(userData).map((date) => getDateKey(date)));
    statusHistory.forEach((item) => {
        if (item.schedule_date) scheduledKeys.add(item.schedule_date);
    });
    const maxCount = Math.max(1, ...days.map((day) => countsByDay.get(day) || 0));

    days.forEach((day) => {
        const key = day;
        const count = countsByDay.get(key) || 0;
        const isScheduled = scheduledKeys.has(key);
        const height = count ? Math.max(28, Math.round((count / maxCount) * 110)) : 14;
        const bar = document.createElement("div");
        bar.className = "weekly-bar-cell";
        const dayLabel = getWeekdayName(day).slice(0, 3).toUpperCase();
        bar.innerHTML = `
            <div class="weekly-bar-value">${count}</div>
            <div class="weekly-bar-track"><div class="weekly-bar-fill" style="height:${height}px; background:${count ? "#e63946" : isScheduled ? "#555" : "#2a2a2a"};"></div></div>
            <div class="weekly-bar-label">${dayLabel}</div>
        `;
        barsRoot.appendChild(bar);
    });
}

function renderAdjustmentHistory(container, adjustments, progressionLogs) {
    const existing = document.getElementById("adjustmentsCard");
    if (existing) existing.remove();

    const card = document.createElement("div");
    card.id = "adjustmentsCard";
    card.className = "ai-prediction-box";
    card.innerHTML = `
        <div class="ai-header">Workout Adjustment History</div>
        <div id="adjustmentList" class="ai-content"></div>
    `;
    container.appendChild(card);

    const list = card.querySelector("#adjustmentList");
    const sorted = [...adjustments].sort((a, b) => (toDateSafe(b.created_at) || 0) - (toDateSafe(a.created_at) || 0));
    const progressionMap = new Map(
        progressionLogs.map((log) => [`${log.workout_day || ""}-${log.muscle_group || ""}`, log])
    );

    if (!sorted.length) {
        list.innerHTML = "No adjustment history yet. Complete more sessions to generate adaptive changes.";
        return;
    }

    list.innerHTML = sorted.slice(0, 12).map((item) => {
        const when = toDateSafe(item.created_at);
        const dateLabel = when ? when.toLocaleDateString() : "Recent";
        const repsText = item.rep_delta_percent > 0 ? `Added reps (+${item.rep_delta_percent}%)` :
            item.rep_delta_percent < 0 ? `Reduced reps (${item.rep_delta_percent}%)` : "Reps unchanged";
        const setsText = item.set_delta_percent > 0 ? `Added sets (+${item.set_delta_percent}%)` :
            item.set_delta_percent < 0 ? `Removed sets (${item.set_delta_percent}%)` : "Sets unchanged";
        const aiText = item.triggered_regeneration ? "AI-generated full regeneration triggered" : "AI-generated progressive adjustment";
        const key = `${item.workout_day || ""}-${item.muscle_group || ""}`;
        const progression = progressionMap.get(key);
        const mode = progression?.progression_mode ? ` • Mode: ${progression.progression_mode}` : "";
        return `
            <div style="margin-bottom:10px; padding-bottom:10px; border-bottom:1px solid #333;">
                <div style="font-weight:700; color:#fff;">${dateLabel} • ${item.muscle_group || "General"}</div>
                <div>${repsText}</div>
                <div>${setsText}</div>
                <div>${aiText}${mode}</div>
            </div>
        `;
    }).join("");
}

export async function initSummaryEngine({ user, userData }) {
    const summaryRoot = document.querySelector(".scrollable-body");
    if (!summaryRoot) return;
    const statsGrid = document.querySelector(".summary-metrics");

    // Major system: fetch historical analytics sources for this authenticated user.
    const [workoutLogs, statusHistory, adjustmentSnap, progressionSnap] = await Promise.all([
        getVerifiedWorkoutLogs(user.uid),
        getWorkoutStatusHistory(user.uid),
        getDocs(query(collection(db, "workout_adjustments"), where("user_id", "==", user.uid))),
        getDocs(query(collection(db, "progression_logs"), where("user_id", "==", user.uid)))
    ]);

    const adjustments = adjustmentSnap.docs.map((docSnap) => docSnap.data());
    const progressionLogs = progressionSnap.docs.map((docSnap) => docSnap.data());

    const validWorkoutLogs = workoutLogs.filter((log) => getDateKey(log.schedule_date || log.created_at));
    const totalCompletedWorkouts = validWorkoutLogs.length;
    const uniqueDays = validWorkoutLogs.map((log) => getDateKey(log.schedule_date || log.created_at)).filter(Boolean);
    const uniqueDaySet = [...new Set(uniqueDays)];
    const completedKeySet = new Set(uniqueDaySet);
    const skippedKeys = new Set(statusHistory.filter((item) => item.status === "skipped").map((item) => item.schedule_date).filter(Boolean));
    const streak = calculateScheduledStreak({ userData, completedKeys: completedKeySet, skippedKeys });

    const durations = workoutLogs.map((log) => Number(log.duration_seconds) || 0).filter((n) => n > 0);
    const longestDuration = durations.length ? Math.max(...durations) : 0;
    const shortestDuration = durations.length ? Math.min(...durations) : 0;
    const avgDuration = average(durations);

    const today = new Date();
    const scheduledDates = getScheduledDates(userData, today);
    const todayKey = getAppDateKey(today);
    const inferredMisses = scheduledDates.filter((date) => date < todayKey && !completedKeySet.has(getDateKey(date))).map((date) => getDateKey(date));
    const missedWorkouts = new Set([...skippedKeys, ...inferredMisses]).size;
    const expectedWorkouts = new Set([...statusHistory.map((item) => item.schedule_date).filter(Boolean), ...scheduledDates.filter((date) => date <= todayKey).map(getDateKey)]).size;

    const completionRate = expectedWorkouts ? uniqueDaySet.length / expectedWorkouts : 0;
    const consistencyRate = completionRate;
    const fatigueHardCount = progressionLogs.filter((log) => log.response === "hard").length;
    const fatigueTrend = progressionLogs.length ? fatigueHardCount / progressionLogs.length : 0;
    const progressionRate = progressionLogs.reduce((acc, log) => {
        if (log.response === "easy") return acc + 1;
        if (log.response === "hard") return acc - 1;
        return acc;
    }, 0) / Math.max(1, progressionLogs.length);

    const daysLiftedEl = document.getElementById("daysLifted");
    const longSessionEl = document.getElementById("longSession");
    const avgSessionEl = document.getElementById("avgSession");
    const shortSessionEl = document.getElementById("shortSession");
    const currentStreakEl = document.getElementById("currentStreak");
    const missedWorkoutsEl = document.getElementById("missedWorkouts");
    if (daysLiftedEl) daysLiftedEl.innerText = String(uniqueDaySet.length);
    if (currentStreakEl) currentStreakEl.innerText = `${streak}`;
    if (missedWorkoutsEl) missedWorkoutsEl.innerText = String(missedWorkouts);
    if (longSessionEl) longSessionEl.innerText = formatDuration(longestDuration);
    if (avgSessionEl) avgSessionEl.innerText = formatDuration(avgDuration);
    if (shortSessionEl) shortSessionEl.innerText = formatDuration(shortestDuration);
    if (statsGrid) statsGrid.querySelectorAll(".dynamic-summary-stat").forEach((node) => node.remove());

    const aiPredictionText = document.getElementById("aiPredictionText");
    if (aiPredictionText) {
        const insights = buildPredictiveInsights({ workoutLogs, progressionLogs, adjustments, userData });
        const analysis = buildPredictiveAnalysis({
            consistencyRate,
            progressionRate,
            fatigueTrend,
            completionRate
        });
        aiPredictionText.innerText = `${analysis} ${buildAdvancedInsightText(insights)} Average workout duration: ${formatDuration(avgDuration)}. Missed workouts: ${missedWorkouts}. Current streak: ${streak}.`;
    }

    const oldCoachCard = document.getElementById("summaryCoachMessage");
    if (oldCoachCard) oldCoachCard.remove();

    renderWeeklyChart(summaryRoot, validWorkoutLogs, userData, statusHistory);
    renderAdjustmentHistory(summaryRoot, adjustments, progressionLogs);
}
