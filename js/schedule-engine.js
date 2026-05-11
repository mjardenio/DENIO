import { db } from "./firebase.js";
import {
    collection,
    doc,
    getDoc,
    getDocs,
    limit,
    query,
    runTransaction,
    serverTimestamp,
    setDoc,
    where
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

// Major date rule: every workout date is reduced to this app-timezone YYYY-MM-DD key.
// Firestore timestamps are still saved, but status decisions never depend on the browser's local midnight.
export const APP_TIME_ZONE = "Asia/Manila";
export const VALID_WORKOUT_STATUSES = ["pending", "completed", "skipped"];
export const WEEKDAYS_MONDAY_FIRST = [
    "MONDAY",
    "TUESDAY",
    "WEDNESDAY",
    "THURSDAY",
    "FRIDAY",
    "SATURDAY",
    "SUNDAY"
];

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_SKIP_BACKFILL_DAYS = 90;

function isPositiveInteger(value) {
    const number = Number(value);
    return Number.isInteger(number) && number > 0;
}

export function normalizeLiftDayNumber(value, fallback = 1) {
    if (isPositiveInteger(value)) return Number(value);
    return isPositiveInteger(fallback) ? Number(fallback) : 1;
}

export function isValidLiftDayNumber(value) {
    return isPositiveInteger(value);
}

export function formatWorkoutDayLabel(dayNumber) {
    return isValidLiftDayNumber(dayNumber) ? `Day ${Number(dayNumber)}` : "Rest Day";
}

function latestByDate(items = []) {
    return [...items].sort((a, b) => String(a.schedule_date || "").localeCompare(String(b.schedule_date || ""))).at(-1) || null;
}

function getHistoryDayNumber(item) {
    return item?.workout_day_number || item?.day_number || item?.lastCompletedWorkoutDay || item?.workoutDay;
}

function getMaxHistoryLiftDay({ workoutLogs = [], statusHistory = [], userData = {} }) {
    const candidates = [
        ...workoutLogs.map(getHistoryDayNumber),
        ...statusHistory.map(getHistoryDayNumber),
        ...(Array.isArray(userData.completedDays) ? userData.completedDays : []),
        userData.lastCompletedWorkoutDay,
        userData.lastCompletedWorkout?.dayNumber
    ].map(Number).filter(isPositiveInteger);
    return candidates.length ? Math.max(...candidates) : 0;
}

function recoverCurrentLiftDay({ userData = {}, workoutLogs = [], statusHistory = [] }) {
    // Data safety rule: a valid saved currentLiftDay is authoritative. History is
    // only a recovery source for missing/corrupt progression, never a reason to
    // reset or move an existing user's valid pointer.
    if (isValidLiftDayNumber(userData.currentLiftDay)) {
        return { currentLiftDay: Number(userData.currentLiftDay), source: "saved" };
    }

    const userProgressDay = userData.userProgress?.currentLiftDay;
    if (isValidLiftDayNumber(userProgressDay)) {
        return { currentLiftDay: Number(userProgressDay), source: "userProgress" };
    }

    const maxHistoryDay = getMaxHistoryLiftDay({ workoutLogs, statusHistory, userData });
    if (maxHistoryDay > 0) {
        return { currentLiftDay: maxHistoryDay + 1, source: "history" };
    }

    return { currentLiftDay: 1, source: "fresh" };
}

function partsInAppTimeZone(value = new Date()) {
    const date = value?.toDate ? value.toDate() : value instanceof Date ? value : new Date(value);
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: APP_TIME_ZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).formatToParts(date);
    const get = (type) => parts.find((part) => part.type === type)?.value;
    return {
        year: get("year"),
        month: get("month"),
        day: get("day")
    };
}

export function getAppDateKey(value = new Date()) {
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    const parts = partsInAppTimeZone(value);
    return `${parts.year}-${parts.month}-${parts.day}`;
}

function keyToUtcMs(dateKey) {
    const [year, month, day] = String(dateKey).split("-").map(Number);
    return Date.UTC(year, month - 1, day);
}

export function addDaysToDateKey(dateKey, days) {
    return getAppDateKey(new Date(keyToUtcMs(dateKey) + (Number(days) || 0) * DAY_MS));
}

export function diffDateKeys(startKey, endKey) {
    return Math.floor((keyToUtcMs(endKey) - keyToUtcMs(startKey)) / DAY_MS);
}

export function getWeekdayIndexMondayFirst(dateKey = getAppDateKey()) {
    const nativeIndex = new Date(keyToUtcMs(dateKey)).getUTCDay();
    return (nativeIndex + 6) % 7;
}

export function getWeekdayName(dateKey) {
    return WEEKDAYS_MONDAY_FIRST[getWeekdayIndexMondayFirst(dateKey)] || "MONDAY";
}

export function getCurrentWeekday(dateKey = getAppDateKey()) {
    return getWeekdayName(dateKey);
}

export function getWorkoutFrequency(userData = {}) {
    const frequency = Number.parseInt(userData.workoutFrequency || userData.frequency, 10);
    return Number.isFinite(frequency) ? Math.min(7, Math.max(1, frequency)) : 3;
}

export function getProfileStartDateKey(userData = {}, planData = {}) {
    return getAppDateKey(userData.progressionStartDate || userData.startDate || planData.created_at || new Date());
}

export function getScheduleForDate(userData = {}, dateKey = getAppDateKey(), planData = {}, options = {}) {
    const startDateKey = getProfileStartDateKey(userData, planData);
    const calendarDayNumber = Math.max(1, diffDateKeys(startDateKey, dateKey) + 1);
    const frequency = getWorkoutFrequency(userData);
    const dayInCycle = ((calendarDayNumber - 1) % 7) + 1;
    const completedCycles = Math.floor((calendarDayNumber - 1) / 7);
    const isScheduled = dayInCycle <= frequency;
    const derivedWorkoutDayNumber = isScheduled ? (completedCycles * frequency) + dayInCycle : null;
    const workoutDayNumber = isScheduled
        ? normalizeLiftDayNumber(options.workoutDayNumberOverride, derivedWorkoutDayNumber)
        : null;

    return {
        dateKey,
        startDateKey,
        timezone: APP_TIME_ZONE,
        calendarDayNumber,
        dayInCycle,
        frequency,
        isScheduled,
        workoutDayNumber,
        workoutLabel: formatWorkoutDayLabel(workoutDayNumber),
        weekdayIndex: getWeekdayIndexMondayFirst(dateKey),
        weekdayName: getWeekdayName(dateKey),
        statusId: `${dateKey}_${isScheduled ? "workout" : "rest"}`
    };
}

function getStatusFromMap(statusByDate, dateKey) {
    if (!statusByDate) return null;
    if (statusByDate instanceof Map) return statusByDate.get(dateKey) || null;
    return statusByDate[dateKey] || null;
}

export function getUpcomingSchedule(userData = {}, planData = {}, count = 7, fromDateKey = getAppDateKey(), progressionState = {}, statusByDate = new Map()) {
    let projectedLiftDay = normalizeLiftDayNumber(progressionState.currentLiftDay || userData.currentLiftDay, 1);

    return Array.from({ length: count }, (_, offset) => {
        const dateKey = addDaysToDateKey(fromDateKey, offset);
        const baseSchedule = getScheduleForDate(userData, dateKey, planData);
        if (!baseSchedule.isScheduled) return baseSchedule;

        const existingStatus = getStatusFromMap(statusByDate, dateKey);
        const existingDayNumber = existingStatus?.workout_day_number || existingStatus?.day_number;
        const workoutDayNumber = isValidLiftDayNumber(existingDayNumber)
            ? Number(existingDayNumber)
            : projectedLiftDay;
        if (!isValidLiftDayNumber(existingDayNumber)) projectedLiftDay += 1;

        return getScheduleForDate(userData, dateKey, planData, { workoutDayNumberOverride: workoutDayNumber });
    });
}

export function getMaxScheduledWorkoutNumber(schedules = []) {
    return Math.max(0, ...schedules.map((item) => Number(item.workoutDayNumber) || 0));
}

export function getRoutineDayForSchedule(planData = {}, schedule) {
    if (!schedule?.isScheduled) {
        return {
            workout_label: "Rest Day",
            schedule_date: schedule?.dateKey,
            focus_label: "Rest Day",
            exercises: []
        };
    }
    const routine = Array.isArray(planData.routine) ? planData.routine : [];
    return routine.find((day) => Number(day.day_number) === Number(schedule.workoutDayNumber)) ||
        routine[Number(schedule.workoutDayNumber) - 1] ||
        {
            day_number: schedule.workoutDayNumber,
            workout_label: formatWorkoutDayLabel(schedule.workoutDayNumber),
            schedule_date: schedule.dateKey,
            focus_label: "Workout Day",
            exercises: []
        };
}

export function getStatusDocRef(userId, schedule) {
    return doc(db, "workout_status", `${userId}_${schedule.statusId}`);
}

function statusRank(status) {
    if (status === "completed") return 3;
    if (status === "skipped") return 2;
    if (status === "pending") return 1;
    return 0;
}

function chooseBestStatus(current, candidate) {
    if (!current) return candidate;
    const currentRank = statusRank(current.status);
    const candidateRank = statusRank(candidate.status);
    if (candidateRank !== currentRank) return candidateRank > currentRank ? candidate : current;
    const currentHasDay = isValidLiftDayNumber(current.workout_day_number || current.day_number);
    const candidateHasDay = isValidLiftDayNumber(candidate.workout_day_number || candidate.day_number);
    if (candidateHasDay && !currentHasDay) return candidate;
    return current;
}

export function buildStatusByDate(statusHistory = []) {
    const statusByDate = new Map();
    statusHistory.forEach((item) => {
        const dateKey = item?.schedule_date;
        if (!dateKey || !VALID_WORKOUT_STATUSES.includes(item.status)) return;
        const current = statusByDate.get(dateKey);
        statusByDate.set(dateKey, chooseBestStatus(current, item));
    });
    return statusByDate;
}

async function fetchStatusForSchedule(userId, schedule) {
    if (!schedule?.isScheduled) return { status: "rest", ...schedule };

    const stableSnap = await getDoc(getStatusDocRef(userId, schedule));
    if (stableSnap.exists()) return { id: stableSnap.id, ...stableSnap.data() };

    // Older builds used date + day-number IDs. Query by date so relogins still
    // find the same workout status after currentLiftDay advances.
    const legacySnap = await getDocs(query(
        collection(db, "workout_status"),
        where("user_id", "==", userId),
        where("schedule_date", "==", schedule.dateKey),
        limit(10)
    ));
    const legacyStatus = legacySnap.docs
        .map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }))
        .filter((item) => VALID_WORKOUT_STATUSES.includes(item.status))
        .reduce((best, item) => chooseBestStatus(best, item), null);

    return legacyStatus || { status: "pending", ...schedule };
}

export async function fetchWorkoutStatuses(userId, schedules = []) {
    const entries = await Promise.all(schedules.map(async (schedule) => {
        if (!schedule.isScheduled) return [schedule.statusId, { status: "rest", ...schedule }];
        const status = await fetchStatusForSchedule(userId, schedule);
        return [schedule.statusId, status];
    }));
    return new Map(entries);
}

export async function ensureSkippedStatuses(userId, userData = {}, planData = {}) {
    return reconcileWorkoutProgression(userId, userData, planData, { allowResetSkip: true });
}

export async function reconcileWorkoutProgression(userId, userData = {}, planData = {}, options = {}) {
    const todayKey = getAppDateKey();
    const startKey = getProfileStartDateKey(userData, planData);
    const elapsedDays = Math.max(0, diffDateKeys(startKey, todayKey));
    const [statusHistory, workoutLogs] = await Promise.all([
        getWorkoutStatusHistory(userId),
        getVerifiedWorkoutLogs(userId)
    ]);
    const statusByDate = buildStatusByDate(statusHistory);

    workoutLogs.forEach((log) => {
        const dateKey = log.schedule_date;
        if (!dateKey) return;
        const completedStatus = {
            status: "completed",
            schedule_date: dateKey,
            workout_day_number: log.workout_day_number || log.day_number,
            calendar_day_number: log.calendar_day_number,
            workout_log_id: log.id,
            source: "workout_log"
        };
        statusByDate.set(dateKey, chooseBestStatus(statusByDate.get(dateKey), completedStatus));
    });

    const recovery = recoverCurrentLiftDay({ userData, workoutLogs, statusHistory });
    const currentLiftDay = recovery.currentLiftDay;
    const lastCompletedLog = latestByDate(workoutLogs.filter((log) => isValidLiftDayNumber(getHistoryDayNumber(log))));
    const lastCompletedWorkout = lastCompletedLog ? {
        dayNumber: Number(getHistoryDayNumber(lastCompletedLog)),
        label: formatWorkoutDayLabel(getHistoryDayNumber(lastCompletedLog)),
        dateKey: lastCompletedLog.schedule_date || getAppDateKey(lastCompletedLog.completed_at || lastCompletedLog.created_at)
    } : null;
    const writes = [];
    const progressionPatch = {};

    const yesterdayKey = addDaysToDateKey(todayKey, -1);
    const shouldApplyResetSkip = options.allowResetSkip === true &&
        userData.lastResetDate === yesterdayKey &&
        (userData.workoutStatus || userData.userProgress?.workoutStatus || "pending") === "pending" &&
        elapsedDays > 0;
    const yesterdaySchedule = getScheduleForDate(userData, yesterdayKey, planData, { workoutDayNumberOverride: currentLiftDay });
    const yesterdayStatus = statusByDate.get(yesterdayKey);

    // Only the explicit reset path may append a skipped status, and only for the
    // immediately previous app date. This keeps old history immutable and avoids
    // login/refresh backfills that can jump existing users forward.
    if (shouldApplyResetSkip && yesterdaySchedule.isScheduled && !yesterdayStatus) {
        const skippedStatus = {
            user_id: userId,
            status: "skipped",
            schedule_date: yesterdayKey,
            workout_day_number: currentLiftDay,
            calendar_day_number: yesterdaySchedule.calendarDayNumber,
            timezone: APP_TIME_ZONE,
            created_at: serverTimestamp(),
            skipped_at: serverTimestamp(),
            skipped_at_date: todayKey,
            source: "daily_reset"
        };
        writes.push(setDoc(getStatusDocRef(userId, yesterdaySchedule), skippedStatus, { merge: true }));
        statusByDate.set(yesterdayKey, { ...skippedStatus, created_at: null, skipped_at: null });
        progressionPatch.currentLiftDay = currentLiftDay + 1;
    }

    const todayBaseSchedule = getScheduleForDate(userData, todayKey, planData);
    const todayStatus = todayBaseSchedule.isScheduled
        ? (statusByDate.get(todayKey)?.status || "pending")
        : "rest";
    const finalLiftDay = normalizeLiftDayNumber(progressionPatch.currentLiftDay || currentLiftDay, 1);
    const currentWeekday = getCurrentWeekday(todayKey);

    if (!isValidLiftDayNumber(userData.currentLiftDay)) progressionPatch.currentLiftDay = finalLiftDay;
    if (userData.currentWeekday !== currentWeekday) progressionPatch.currentWeekday = currentWeekday;
    if (userData.workoutStatus !== todayStatus) progressionPatch.workoutStatus = todayStatus;
    if (!userData.progressionStartDate && startKey) progressionPatch.progressionStartDate = startKey;
    if (shouldApplyResetSkip || !userData.lastResetDate) progressionPatch.lastResetDate = todayKey;
    if (lastCompletedWorkout && !userData.lastCompletedWorkout) {
        progressionPatch.lastCompletedWorkout = lastCompletedWorkout;
        progressionPatch.lastCompletedWorkoutDay = lastCompletedWorkout.dayNumber;
        progressionPatch.lastWorkoutCompletedDate = lastCompletedWorkout.dateKey;
    }
    if (!userData.userProgress || !isValidLiftDayNumber(userData.userProgress.currentLiftDay)) {
        progressionPatch.userProgress = {
            ...(userData.userProgress || {}),
            currentLiftDay: finalLiftDay,
            currentWorkoutId: todayBaseSchedule.isScheduled ? `${todayKey}_${finalLiftDay}` : null,
            currentWeekday,
            workoutStatus: todayStatus,
            lastCompletedDate: userData.lastWorkoutCompletedDate || lastCompletedWorkout?.dateKey || null,
            lastResetDate: progressionPatch.lastResetDate || userData.lastResetDate || todayKey,
            streak: userData.userProgress?.streak ?? userData.streak ?? null
        };
    }
    if (Object.keys(progressionPatch).length) {
        progressionPatch.progressionUpdatedAt = serverTimestamp();
        progressionPatch.progressionUpdatedAtIso = new Date().toISOString();
        progressionPatch.progressionRepairSource = recovery.source;
        writes.push(setDoc(doc(db, "users", userId), progressionPatch, { merge: true }));
    }

    const results = await Promise.allSettled(writes);
    const failed = results.filter((result) => result.status === "rejected");
    if (failed.length) console.warn("Some workout progression writes failed:", failed);

    return {
        ...userData,
        ...progressionPatch,
        currentLiftDay: finalLiftDay,
        currentWeekday,
        workoutStatus: todayStatus,
        progressionStartDate: userData.progressionStartDate || startKey,
        statusByDate
    };
}

export async function completeScheduledWorkout({ userId, schedule, summaryPayload }) {
    if (!schedule?.isScheduled || !isValidLiftDayNumber(schedule.workoutDayNumber)) {
        throw new Error("Cannot complete an unscheduled workout day.");
    }
    if (schedule.dateKey !== getAppDateKey()) {
        throw new Error("Only the current scheduled workout can be completed.");
    }

    const statusRef = getStatusDocRef(userId, schedule);
    const logId = `${userId}_${schedule.dateKey}_${schedule.workoutDayNumber}`;
    const logRef = doc(db, "workout_logs", logId);
    const userRef = doc(db, "users", userId);
    const existingDateStatus = await fetchStatusForSchedule(userId, schedule);
    if (existingDateStatus?.status === "skipped") {
        throw new Error("This workout was already marked skipped.");
    }
    if (existingDateStatus?.status === "completed") {
        return { duplicate: true, logId: existingDateStatus.workout_log_id || logId };
    }

    // One transaction owns both the status doc and the log doc, preventing duplicate
    // completions when the user refreshes, double-clicks, or reopens the app.
    return runTransaction(db, async (transaction) => {
        const [statusSnap, logSnap, userSnap] = await Promise.all([
            transaction.get(statusRef),
            transaction.get(logRef),
            transaction.get(userRef)
        ]);
        const existingStatus = statusSnap.exists() ? statusSnap.data()?.status : "pending";

        if (existingStatus === "skipped") {
            throw new Error("This workout was already marked skipped.");
        }
        if (existingStatus === "completed" || logSnap.exists()) {
            return { duplicate: true, logId };
        }
        const savedCurrentLiftDay = userSnap.exists() ? userSnap.data()?.currentLiftDay : null;
        if (isValidLiftDayNumber(savedCurrentLiftDay) && Number(savedCurrentLiftDay) > Number(schedule.workoutDayNumber)) {
            throw new Error("This workout is no longer the active lifting day.");
        }

        const logPayload = {
            ...summaryPayload,
            user_id: userId,
            day_number: schedule.workoutDayNumber,
            workout_day_number: schedule.workoutDayNumber,
            calendar_day_number: schedule.calendarDayNumber,
            schedule_date: schedule.dateKey,
            timezone: APP_TIME_ZONE,
            status: "completed",
            created_at: serverTimestamp(),
            completed_at: serverTimestamp()
        };

        transaction.set(logRef, logPayload);
        transaction.set(statusRef, {
            user_id: userId,
            status: "completed",
            schedule_date: schedule.dateKey,
            workout_day_number: schedule.workoutDayNumber,
            calendar_day_number: schedule.calendarDayNumber,
            workout_log_id: logId,
            timezone: APP_TIME_ZONE,
            completed_at: serverTimestamp(),
            updated_at: serverTimestamp()
        }, { merge: true });

        const currentLiftDay = normalizeLiftDayNumber(savedCurrentLiftDay, schedule.workoutDayNumber);
        const nextLiftDay = Math.max(currentLiftDay, schedule.workoutDayNumber + 1);
        transaction.set(userRef, {
            currentLiftDay: nextLiftDay,
            currentWeekday: getCurrentWeekday(schedule.dateKey),
            lastCompletedWorkout: {
                dayNumber: schedule.workoutDayNumber,
                label: formatWorkoutDayLabel(schedule.workoutDayNumber),
                dateKey: schedule.dateKey
            },
            lastResetDate: schedule.dateKey,
            workoutStatus: "completed",
            lastWorkoutCompletedDate: schedule.dateKey,
            lastCompletedWorkoutDay: schedule.workoutDayNumber,
            progressionUpdatedAt: serverTimestamp(),
            progressionUpdatedAtIso: new Date().toISOString()
        }, { merge: true });

        return { duplicate: false, logId };
    });
}

export async function getVerifiedWorkoutLogs(userId) {
    const snap = await getDocs(query(
        collection(db, "workout_logs"),
        where("user_id", "==", userId),
        limit(500)
    ));
    return snap.docs
        .map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }))
        .filter((log) => log.status === "completed" || !log.status);
}

export async function getWorkoutStatusHistory(userId) {
    const snap = await getDocs(query(
        collection(db, "workout_status"),
        where("user_id", "==", userId),
        limit(500)
    ));
    return snap.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }))
        .filter((item) => VALID_WORKOUT_STATUSES.includes(item.status));
}
