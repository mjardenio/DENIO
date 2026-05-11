import { auth, db } from "./firebase.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import {
    collection,
    deleteDoc,
    doc,
    getDocs,
    limit,
    onSnapshot,
    query,
    where,
    writeBatch
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import {
    createAdminNotification,
    formatDateTime,
    getDisplayName,
    getUserSearchText,
    getWorkoutLogsForUsers,
    isUserActive,
    listenToAdminNotifications,
    markNotificationsRead,
    summarizeWorkoutLogs,
    toDateSafe
} from "./admin-services.js";

const PAGE_SIZE = 10;

const state = {
    allUsers: [],
    filteredUsers: [],
    visibleUsers: [],
    workoutStats: new Map(),
    notifications: [],
    page: 1,
    unsubscribeUsers: null,
    unsubscribeNotifications: null,
    selectedDeleteId: null,
    searchTerm: "",
    levelFilter: "all",
    statusFilter: "all"
};
let notificationOpenCount = 0;

window.denioAdminModuleLoaded = true;

function getControls() {
    return {
        search: document.getElementById("adminUserSearch"),
        level: document.getElementById("adminLevelFilter"),
        status: document.getElementById("adminStatusFilter"),
        tbody: document.getElementById("adminUserList"),
        prev: document.getElementById("adminUsersPrev"),
        next: document.getElementById("adminUsersNext"),
        pageLabel: document.getElementById("adminUsersPageLabel"),
        modal: document.getElementById("deleteUserModal"),
        modalName: document.getElementById("deleteUserName"),
        confirmDelete: document.getElementById("confirmDeleteUserBtn"),
        cancelDelete: document.getElementById("cancelDeleteUserBtn"),
        closeDelete: document.getElementById("closeDeleteUserModal")
    };
}

function sanitize(text) {
    const div = document.createElement("div");
    div.innerText = String(text ?? "");
    return div.innerHTML;
}

function debounce(fn, delay = 220) {
    let timer = null;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), delay);
    };
}

function sortUsers(users) {
    return [...users].sort((a, b) => {
        const bDate = toDateSafe(b.lastLoginAt || b.lastLoginAtIso || b.createdAt || b.startDate)?.getTime() || 0;
        const aDate = toDateSafe(a.lastLoginAt || a.lastLoginAtIso || a.createdAt || a.startDate)?.getTime() || 0;
        if (bDate !== aDate) return bDate - aDate;
        return getDisplayName(a).localeCompare(getDisplayName(b));
    });
}

function getGoalText(user) {
    const goals = user.goals || user.goal || user.fitnessGoal || [];
    if (Array.isArray(goals)) return goals.length ? goals.join(", ") : "No goal";
    return goals || "No goal";
}

function getUserInitial(user) {
    return getDisplayName(user).charAt(0).toUpperCase() || "U";
}

function getUserCompletedWorkouts(userId) {
    return state.workoutStats.get(userId)?.completedWorkouts || 0;
}

function getUserStreak(userId) {
    return state.workoutStats.get(userId)?.streak || 0;
}

function matchesFilters(user) {
    if (state.searchTerm && !getUserSearchText(user).includes(state.searchTerm)) return false;

    if (state.levelFilter !== "all") {
        const level = String(user.fitnessLevel || user.level || "").toLowerCase();
        if (level !== state.levelFilter) return false;
    }

    if (state.statusFilter !== "all") {
        const active = isUserActive(user);
        if (state.statusFilter === "active" && !active) return false;
        if (state.statusFilter === "offline" && active) return false;
    }

    return true;
}

function paginateUsers() {
    const start = (state.page - 1) * PAGE_SIZE;
    state.visibleUsers = state.filteredUsers.slice(start, start + PAGE_SIZE);
}

function applyFilters(resetPage = true) {
    if (resetPage) state.page = 1;
    state.filteredUsers = sortUsers(state.allUsers.filter(matchesFilters));
    paginateUsers();
    hydrateVisibleWorkoutStats();
    renderUsers();
}

async function hydrateVisibleWorkoutStats() {
    const userIds = state.visibleUsers.map((user) => user.id);
    if (!userIds.length) {
        state.workoutStats = new Map();
        renderUsers();
        return;
    }

    try {
        const logs = await getWorkoutLogsForUsers(userIds);
        state.workoutStats = summarizeWorkoutLogs(logs);
        renderUsers();
    } catch (error) {
        console.warn("Could not load visible user workout stats:", error);
    }
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
            <div class="notif-text">${item.message || "Admin activity recorded."}</div>
        </div>
    `).join("");
}

function renderUsers() {
    const { tbody, prev, next, pageLabel } = getControls();
    if (!tbody) return;

    if (!state.allUsers.length) {
        tbody.innerHTML = `<tr><td colspan="3" style="text-align:center; color:#888;">No users found in Firestore.</td></tr>`;
    } else if (!state.filteredUsers.length) {
        tbody.innerHTML = `<tr><td colspan="3" style="text-align:center; color:#888;">No users match your search or filters.</td></tr>`;
    } else {
        tbody.innerHTML = state.visibleUsers.map((user) => {
            const displayName = getDisplayName(user);
            const email = user.email || "No email";
            const goal = getGoalText(user);
            const level = user.fitnessLevel || user.level || "Unknown";
            const streak = getUserStreak(user.id);
            const completed = getUserCompletedWorkouts(user.id);
            const active = isUserActive(user);
            const statusClass = active ? "active" : "offline";
            const statusText = active ? "Active" : "Inactive";

            return `
                <tr>
                    <td>
                        <div class="user-cell">
                            <div class="user-avatar-small">${sanitize(getUserInitial(user))}</div>
                            <div>
                                <span>${sanitize(displayName)}</span>
                                <div class="admin-user-meta">${sanitize(email)}</div>
                                <div class="admin-user-meta">Goal: ${sanitize(goal)}</div>
                                <div class="admin-user-meta">Level: ${sanitize(level)} • ${completed} workouts • ${streak}-day streak</div>
                                <div class="admin-user-meta">Last login: ${sanitize(formatDateTime(user.lastLoginAt || user.lastLoginAtIso))}</div>
                            </div>
                        </div>
                    </td>
                    <td class="col-center"><span class="status-pill ${statusClass}">${statusText}</span></td>
                    <td class="col-center"><button class="text-btn-delete" title="Delete User" data-delete-user="${user.id}">✖</button></td>
                </tr>
            `;
        }).join("");
    }

    tbody.querySelectorAll("[data-delete-user]").forEach((button) => {
        button.addEventListener("click", () => openDeleteModal(button.dataset.deleteUser));
    });

    const totalPages = Math.max(1, Math.ceil(state.filteredUsers.length / PAGE_SIZE));
    if (prev) prev.disabled = state.page <= 1;
    if (next) next.disabled = state.page >= totalPages;
    if (pageLabel) pageLabel.innerText = `Page ${state.page} of ${totalPages}`;
}

function setLoadingState() {
    const { tbody } = getControls();
    if (tbody) tbody.innerHTML = `<tr><td colspan="3" style="text-align:center; color:#888;">Loading users...</td></tr>`;
}

function subscribeUsers() {
    setLoadingState();
    if (state.unsubscribeUsers) state.unsubscribeUsers();

    state.unsubscribeUsers = onSnapshot(collection(db, "users"), (snapshot) => {
        state.allUsers = snapshot.docs
            .map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }))
            .filter((user) => user.email !== "admin@denio.app" && user.role !== "admin" && user.isAdmin !== true);
        applyFilters(false);
    }, (error) => {
        console.error("Admin users realtime error:", error);
        const { tbody } = getControls();
        if (tbody) tbody.innerHTML = `<tr><td colspan="3" style="text-align:center; color:#e63946;">Failed to load users from Firestore.</td></tr>`;
    });
}

function openDeleteModal(userId) {
    const controls = getControls();
    const user = state.allUsers.find((item) => item.id === userId);
    state.selectedDeleteId = userId;
    if (controls.modalName) controls.modalName.innerText = getDisplayName(user);
    if (controls.modal) controls.modal.style.display = "flex";
}

function closeDeleteModal() {
    const controls = getControls();
    state.selectedDeleteId = null;
    if (controls.modal) controls.modal.style.display = "none";
}

async function deleteQueryDocs(collectionName, field, value) {
    const snap = await getDocs(query(collection(db, collectionName), where(field, "==", value), limit(450)));
    if (snap.empty) return;
    const batch = writeBatch(db);
    snap.docs.forEach((docSnap) => batch.delete(docSnap.ref));
    await batch.commit();
}

async function deleteKnownUserData(userId) {
    await Promise.allSettled([
        deleteQueryDocs("workout_logs", "user_id", userId),
        deleteQueryDocs("survey_responses", "user_id", userId),
        deleteQueryDocs("progression_logs", "user_id", userId),
        deleteQueryDocs("workout_adjustments", "user_id", userId),
        deleteQueryDocs("ai_rule_logs", "user_id", userId),
        deleteDoc(doc(db, "workout_plans", userId))
    ]);
    await deleteDoc(doc(db, "users", userId));
}

async function confirmDeleteUser() {
    if (!state.selectedDeleteId) return;
    const controls = getControls();
    const deleteId = state.selectedDeleteId;
    if (controls.confirmDelete) controls.confirmDelete.disabled = true;

    state.allUsers = state.allUsers.filter((user) => user.id !== deleteId);
    closeDeleteModal();
    applyFilters(false);

    try {
        // Admin UI cleanup is intentionally data-only. The Firebase Auth account remains intact.
        await deleteKnownUserData(deleteId);
    } catch (error) {
        console.error("Failed to delete user data:", error);
        window.alert("Failed to delete user data. Firestore permissions may need to be updated.");
        subscribeUsers();
    } finally {
        if (controls.confirmDelete) controls.confirmDelete.disabled = false;
    }
}

function wireControls() {
    const controls = getControls();

    if (controls.search) {
        controls.search.addEventListener("input", debounce((event) => {
            state.searchTerm = event.target.value.trim().toLowerCase();
            applyFilters(true);
        }));
    }
    if (controls.level) {
        controls.level.addEventListener("change", (event) => {
            state.levelFilter = event.target.value;
            applyFilters(true);
        });
    }
    if (controls.status) {
        controls.status.addEventListener("change", (event) => {
            state.statusFilter = event.target.value;
            applyFilters(true);
        });
    }
    if (controls.prev) {
        controls.prev.addEventListener("click", () => {
            state.page = Math.max(1, state.page - 1);
            paginateUsers();
            hydrateVisibleWorkoutStats();
            renderUsers();
        });
    }
    if (controls.next) {
        controls.next.addEventListener("click", () => {
            const totalPages = Math.max(1, Math.ceil(state.filteredUsers.length / PAGE_SIZE));
            state.page = Math.min(totalPages, state.page + 1);
            paginateUsers();
            hydrateVisibleWorkoutStats();
            renderUsers();
        });
    }
    if (controls.cancelDelete) controls.cancelDelete.addEventListener("click", closeDeleteModal);
    if (controls.closeDelete) controls.closeDelete.addEventListener("click", closeDeleteModal);
    if (controls.modal) {
        controls.modal.addEventListener("click", (event) => {
            if (event.target === controls.modal) closeDeleteModal();
        });
    }
    if (controls.confirmDelete) controls.confirmDelete.addEventListener("click", confirmDeleteUser);

    const notifBtn = document.getElementById("notifBtn");
    if (notifBtn) {
        notifBtn.addEventListener("click", () => {
            notificationOpenCount += 1;
            if (notificationOpenCount >= 2) setTimeout(() => markNotificationsRead(state.notifications), 0);
        });
    }
}

function initAdminAuth() {
    onAuthStateChanged(auth, (user) => {
        if (!user || user.email !== "admin@denio.app") {
            window.location.href = "../profile/admin-login.html";
            return;
        }
        subscribeUsers();
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
    wireControls();
    initAdminAuth();
    state.unsubscribeNotifications = listenToAdminNotifications((notifications) => {
        state.notifications = notifications;
        renderNotifications();
    });
});
