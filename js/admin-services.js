import { db } from "./firebase.js";
import {
    addDoc,
    collection,
    doc,
    getDocs,
    limit,
    onSnapshot,
    orderBy,
    query,
    serverTimestamp,
    updateDoc,
    where,
    writeBatch
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

export const ACTIVE_WINDOW_MS = 1000 * 60 * 15;

export function toDateSafe(value) {
    if (!value) return null;
    if (typeof value.toDate === "function") return value.toDate();
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function formatDateTime(value) {
    const date = toDateSafe(value);
    if (!date) return "Never";
    return date.toLocaleString([], {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit"
    });
}

export function formatDuration(seconds) {
    const safe = Math.max(0, Number(seconds) || 0);
    if (!safe) return "0 min";
    const minutes = Math.round(safe / 60);
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${hours}h ${mins}m`;
}

export function getDisplayName(userData) {
    return userData?.name || userData?.displayName || userData?.username || userData?.email || "DENIO User";
}

export function isUserActive(userData) {
    if (userData?.isActive === false) return false;
    const lastSeen = toDateSafe(userData?.lastSeenAt || userData?.lastLoginAt || userData?.last_login_at || userData?.lastLoginAtIso);
    return Boolean(userData?.isActive === true && lastSeen && Date.now() - lastSeen.getTime() <= ACTIVE_WINDOW_MS);
}

export function getUserSearchText(userData) {
    return [
        userData?.username,
        userData?.name,
        userData?.displayName,
        userData?.email
    ].filter(Boolean).join(" ").toLowerCase();
}

function escapeHtml(value) {
    const div = document.createElement("div");
    div.innerText = String(value ?? "");
    return div.innerHTML;
}

export function calculateStreakFromLogs(logs) {
    const dayKeys = logs
        .map((log) => toDateSafe(log.created_at))
        .filter(Boolean)
        .map((date) => {
            const d = new Date(date);
            d.setHours(0, 0, 0, 0);
            return d.toISOString().slice(0, 10);
        });

    const uniqueDays = [...new Set(dayKeys)].sort((a, b) => new Date(b) - new Date(a));
    if (!uniqueDays.length) return 0;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const latest = new Date(uniqueDays[0]);
    if (Math.floor((today - latest) / (1000 * 60 * 60 * 24)) > 1) return 0;

    let streak = 1;
    for (let i = 0; i < uniqueDays.length - 1; i++) {
        const current = new Date(uniqueDays[i]);
        const next = new Date(uniqueDays[i + 1]);
        const gap = Math.floor((current - next) / (1000 * 60 * 60 * 24));
        if (gap !== 1) break;
        streak += 1;
    }
    return streak;
}

export function getExpectedWorkoutDays(userData) {
    const start = toDateSafe(userData?.startDate || userData?.createdAt || userData?.created_at);
    if (!start) return 0;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const startDate = new Date(start);
    startDate.setHours(0, 0, 0, 0);
    const elapsedDays = Math.max(1, Math.floor((today - startDate) / (1000 * 60 * 60 * 24)) + 1);
    const frequency = Number.parseInt(userData?.workoutFrequency || userData?.frequency, 10);
    if (Number.isFinite(frequency) && frequency > 0) {
        return Math.max(1, Math.round((elapsedDays / 7) * Math.min(frequency, 7)));
    }
    return elapsedDays;
}

export function getConsistencyLabel(completed, expected) {
    if (!expected) return "new";
    const rate = completed / expected;
    if (rate >= 0.75) return "high";
    if (rate >= 0.4) return "medium";
    return "low";
}

export function summarizeWorkoutLogs(logs) {
    const byUser = new Map();
    logs.forEach((log) => {
        const userId = log.user_id;
        if (!userId) return;
        if (!byUser.has(userId)) byUser.set(userId, []);
        byUser.get(userId).push(log);
    });

    const stats = new Map();
    byUser.forEach((userLogs, userId) => {
        stats.set(userId, {
            completedWorkouts: userLogs.length,
            streak: calculateStreakFromLogs(userLogs),
            totalDuration: userLogs.reduce((acc, log) => acc + (Number(log.duration_seconds) || 0), 0),
            latestWorkoutAt: userLogs
                .map((log) => toDateSafe(log.created_at))
                .filter(Boolean)
                .sort((a, b) => b - a)[0] || null
        });
    });
    return stats;
}

export async function createAdminNotification(type, actor = {}, metadata = {}) {
    const actorName = escapeHtml(actor.name || actor.displayName || actor.email || "A DENIO user");
    const messages = {
        user_login: `<b>${actorName}</b> logged in.`,
        user_logout: `<b>${actorName}</b> logged out.`,
        workout_completed: `<b>${actorName}</b> completed a workout.`,
        user_registered: `New user <b>${actorName}</b> registered.`
    };

    try {
        await addDoc(collection(db, "admin_notifications"), {
            type,
            message: messages[type] || `<b>${actorName}</b> triggered an admin event.`,
            actor_uid: actor.uid || null,
            actor_name: actorName,
            actor_email: actor.email || null,
            metadata,
            read: false,
            created_at: serverTimestamp(),
            created_at_iso: new Date().toISOString()
        });
    } catch (error) {
        console.warn("Admin notification write skipped:", error);
    }
}

export function listenToAdminNotifications(callback, maxItems = 20) {
    return onSnapshot(
        query(collection(db, "admin_notifications"), orderBy("created_at", "desc"), limit(maxItems)),
        (snapshot) => callback(snapshot.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }))),
        (error) => {
            console.warn("Admin notifications unavailable:", error);
            callback([]);
        }
    );
}

export async function markNotificationsRead(notifications) {
    const unread = notifications.filter((item) => item.read === false);
    if (!unread.length) return;
    const batch = writeBatch(db);
    unread.forEach((item) => batch.update(doc(db, "admin_notifications", item.id), { read: true }));
    await batch.commit();
}

export async function updateUserPresence(user, patch = {}) {
    if (!user?.uid) return;
    try {
        await updateDoc(doc(db, "users", user.uid), patch);
    } catch (error) {
        console.warn("User presence update skipped:", error);
    }
}

export async function getAllWorkoutLogs() {
    const snap = await getDocs(query(collection(db, "workout_logs"), orderBy("created_at", "desc")));
    return snap.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
}

export async function getWorkoutLogsForUsers(userIds) {
    if (!userIds.length) return [];
    const uniqueIds = [...new Set(userIds)];
    const chunks = [];
    for (let i = 0; i < uniqueIds.length; i += 10) chunks.push(uniqueIds.slice(i, i + 10));

    const results = [];
    for (const ids of chunks) {
        const snap = await getDocs(query(collection(db, "workout_logs"), where("user_id", "in", ids)));
        snap.forEach((docSnap) => results.push({ id: docSnap.id, ...docSnap.data() }));
    }
    return results;
}
