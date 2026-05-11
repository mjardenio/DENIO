import { auth, db } from "./firebase.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { collection, onSnapshot, query } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import {
    createAdminNotification,
    formatDuration,
    getExpectedWorkoutDays,
    isUserActive,
    listenToAdminNotifications,
    markNotificationsRead,
    toDateSafe
} from "./admin-services.js";

const state = {
    users: [],
    workouts: [],
    notifications: [],
    unsubscribers: []
};
let notificationOpenCount = 0;

window.denioAdminModuleLoaded = true;

function formatNumber(value) {
    return new Intl.NumberFormat().format(Number(value) || 0);
}

function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.innerText = text;
}

function getUserCreatedDate(user) {
    return toDateSafe(user.createdAt || user.created_at || user.startDate || user.lastLoginAt);
}

function getWorkoutUserCounts(workouts) {
    const counts = new Map();
    workouts.forEach((workout) => {
        if (!workout.user_id) return;
        counts.set(workout.user_id, (counts.get(workout.user_id) || 0) + 1);
    });
    return counts;
}

function calculateMetrics() {
    const workoutCounts = getWorkoutUserCounts(state.workouts);
    const totalUsers = state.users.length;
    const activeUsers = state.users.filter((user) => isUserActive(user)).length;
    const completedWorkouts = state.workouts.length;
    const totalDuration = state.workouts.reduce((acc, log) => acc + (Number(log.duration_seconds) || 0), 0);
    const avgDuration = completedWorkouts ? totalDuration / completedWorkouts : 0;

    const expected = state.users.reduce((acc, user) => acc + getExpectedWorkoutDays(user), 0);
    const missed = Math.max(0, expected - completedWorkouts);
    const missedPercent = expected ? Math.round((missed / expected) * 100) : 0;
    const completionPercent = expected ? Math.min(100, Math.round((completedWorkouts / expected) * 100)) : 0;

    return {
        totalUsers,
        activeUsers,
        completedWorkouts,
        missedPercent,
        completionPercent,
        avgDuration,
        totalSessions: Array.from(workoutCounts.values()).reduce((acc, n) => acc + n, 0)
    };
}

function countValues(items, getValues) {
    const counts = new Map();
    items.forEach((item) => {
        const values = getValues(item);
        const normalized = Array.isArray(values) ? values : [values];
        normalized.filter(Boolean).forEach((value) => {
            const key = String(value).trim();
            if (!key) return;
            counts.set(key, (counts.get(key) || 0) + 1);
        });
    });
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function getUserGrowthData() {
    const labels = [];
    const counts = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (let i = 5; i >= 0; i--) {
        const d = new Date(today);
        d.setMonth(today.getMonth() - i);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        labels.push(d.toLocaleDateString([], { month: "short" }));
        counts.push(state.users.filter((user) => {
            const created = getUserCreatedDate(user);
            if (!created) return false;
            const createdKey = `${created.getFullYear()}-${String(created.getMonth() + 1).padStart(2, "0")}`;
            return createdKey <= key;
        }).length);
    }

    return { labels, counts };
}

function renderGrowthChart() {
    const target = document.getElementById("userGrowthChart");
    if (!target) return;
    const { labels, counts } = getUserGrowthData();
    const max = Math.max(1, ...counts);
    const width = 600;
    const height = 230;
    const pad = { left: 44, right: 22, top: 24, bottom: 38 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    const points = counts.map((count, index) => {
        const x = pad.left + index * (plotW / Math.max(1, counts.length - 1));
        const y = pad.top + plotH - (count / max) * plotH;
        return `${x},${y}`;
    }).join(" ");

    target.innerHTML = `
        <svg viewBox="0 0 ${width} ${height}" class="admin-svg-chart" role="img" aria-label="User growth chart" preserveAspectRatio="xMidYMid meet">
            <line x1="${pad.left}" y1="${pad.top + plotH}" x2="${width - pad.right}" y2="${pad.top + plotH}" stroke="#e5e7eb" stroke-width="2"></line>
            <line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${pad.top + plotH}" stroke="#e5e7eb" stroke-width="2"></line>
            <polyline points="${points}" fill="none" stroke="#e63946" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"></polyline>
            ${counts.map((count, index) => {
                const x = pad.left + index * (plotW / Math.max(1, counts.length - 1));
                const y = pad.top + plotH - (count / max) * plotH;
                return `<circle cx="${x}" cy="${y}" r="6" fill="#e63946"></circle><text x="${x}" y="${Math.max(16, y - 12)}" text-anchor="middle" font-size="13" fill="#444" font-weight="700">${count}</text>`;
            }).join("")}
            ${labels.map((label, index) => `<text x="${pad.left + index * (plotW / Math.max(1, labels.length - 1))}" y="${height - 12}" text-anchor="middle" font-size="12" fill="#777" font-weight="700">${label}</text>`).join("")}
        </svg>
    `;
}

function renderPieChart(targetId, data) {
    const target = document.getElementById(targetId);
    if (!target) return;
    const total = data.reduce((acc, [, count]) => acc + count, 0);
    if (!total) {
        target.innerHTML = `<div style="color:#999; font-size:13px;">No data yet</div>`;
        return;
    }

    const colors = ["#e63946", "#111111", "#4CAF50", "#888888", "#f59e0b", "#2563eb", "#7c3aed"];
    let running = 0;
    const gradient = data.map(([, count], index) => {
        const start = running;
        running += (count / total) * 100;
        return `${colors[index % colors.length]} ${start}% ${running}%`;
    }).join(", ");

    target.innerHTML = `
        <div class="admin-pie-render" style="background: conic-gradient(${gradient});"></div>
        <div class="admin-pie-legend">
            ${data.slice(0, 6).map(([label, count], index) => `
                <div class="admin-legend-row">
                    <span style="background:${colors[index % colors.length]}"></span>
                    <strong title="${label}">${label}</strong>
                    <em>${Math.round((count / total) * 100)}%</em>
                </div>
            `).join("")}
        </div>
    `;
}

function renderCharts() {
    renderGrowthChart();
    renderPieChart("fitnessGoalsChart", countValues(state.users, (user) => user.goals || user.goal));
    renderPieChart("muscleGoalsChart", countValues(state.users, (user) => user.focusAreas || user.muscleGoals || user.bodyGoals));
    renderPieChart("fitnessLevelChart", countValues(state.users, (user) => user.fitnessLevel || user.level || "Unknown"));
}

function renderMetrics() {
    const metrics = calculateMetrics();
    setText("totalUsersMetric", formatNumber(metrics.totalUsers));
    setText("activeUsersMetric", formatNumber(metrics.activeUsers));
    setText("sessionCompletionMetric", `${metrics.completionPercent}%`);
    setText("missedWorkoutsMetric", `${metrics.missedPercent}%`);
    setText("avgDurationMetric", formatDuration(metrics.avgDuration));
    renderCharts();
}

function renderNotifications() {
    const list = document.querySelector("#notifDropdown .notif-list");
    const badge = document.getElementById("notifBadge");
    if (!list || !badge) return;

    const unread = state.notifications.filter((item) => item.read === false).length;
    badge.innerText = String(unread);
    badge.style.display = unread > 0 ? "inline-flex" : "none";

    if (!state.notifications.length) {
        list.innerHTML = `<div class="notif-item old"><span class="indicator"></span><div class="notif-text">No notifications yet.</div></div>`;
        return;
    }

    list.innerHTML = state.notifications.map((item) => `
        <div class="notif-item ${item.read === false ? "new" : "old"}" data-unread="${item.read === false}">
            <span class="indicator"></span>
            <div class="notif-text">
                ${item.message || "Admin activity recorded."}
                <div style="font-size:11px; color:#999; margin-top:4px;">${toDateSafe(item.created_at)?.toLocaleString() || ""}</div>
            </div>
        </div>
    `).join("");
}

function initNotificationDropdown() {
    const notifBtn = document.getElementById("notifBtn");
    if (!notifBtn) return;
    notifBtn.addEventListener("click", () => {
        notificationOpenCount += 1;
        if (notificationOpenCount >= 2) setTimeout(() => markNotificationsRead(state.notifications), 0);
    });
}

function subscribeDashboard() {
    state.unsubscribers.push(onSnapshot(query(collection(db, "users")), (snapshot) => {
        state.users = snapshot.docs
            .map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }))
            .filter((user) => user.email !== "admin@denio.app" && user.role !== "admin" && user.isAdmin !== true);
        renderMetrics();
    }));

    state.unsubscribers.push(onSnapshot(query(collection(db, "workout_logs")), (snapshot) => {
        state.workouts = snapshot.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
        renderMetrics();
    }));

    state.unsubscribers.push(listenToAdminNotifications((notifications) => {
        state.notifications = notifications;
        renderNotifications();
    }));
}

function initAdminAuth() {
    onAuthStateChanged(auth, (user) => {
        if (!user || user.email !== "admin@denio.app") {
            window.location.href = "../profile/admin-login.html";
            return;
        }
        subscribeDashboard();
    });

    const logoutBtn = document.getElementById("adminLogoutBtn");
    if (logoutBtn) {
        logoutBtn.addEventListener("click", async (event) => {
            event.preventDefault();
            createAdminNotification("user_logout", { uid: auth.currentUser?.uid, email: auth.currentUser?.email, name: "Admin" });
            await signOut(auth);
            window.location.href = "../profile/admin-login.html";
        });
    }
}

document.addEventListener("DOMContentLoaded", () => {
    initNotificationDropdown();
    initAdminAuth();
});
