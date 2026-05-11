import { auth, db } from "./firebase.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import {
    addDoc,
    collection,
    deleteDoc,
    doc,
    onSnapshot,
    orderBy,
    query,
    serverTimestamp,
    updateDoc
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { normalizeRule } from "./adaptive-engine.js";
import { listenToAdminNotifications, markNotificationsRead } from "./admin-services.js";

const state = { rules: [], editingId: null, deletingId: null, notifications: [] };
let notificationOpenCount = 0;
window.denioAdminModuleLoaded = true;

function dom() {
    return {
        list: document.getElementById("adminRulesList"),
        modal: document.getElementById("ruleModal"),
        close: document.getElementById("closeRuleModal"),
        save: document.getElementById("saveRuleBtn"),
        id: document.getElementById("ruleIdInput"),
        title: document.getElementById("ruleTitleInput"),
        description: document.getElementById("ruleDescriptionInput"),
        goalGroup: document.getElementById("ruleGoalGroup"),
        muscleGroup: document.getElementById("ruleMuscleGroup"),
        level: document.getElementById("ruleLevelInput"),
        intensity: document.getElementById("ruleIntensityInput"),
        recovery: document.getElementById("ruleRecoveryInput"),
        reps: document.getElementById("ruleRepInput"),
        priority: document.getElementById("rulePriorityInput"),
        addBtn: document.getElementById("addRuleBtn"),
        deleteModal: document.getElementById("deleteRuleModal"),
        deleteName: document.getElementById("deleteRuleName"),
        closeDelete: document.getElementById("closeDeleteRuleModal"),
        cancelDelete: document.getElementById("cancelDeleteRuleBtn"),
        confirmDelete: document.getElementById("confirmDeleteRuleBtn")
    };
}

function sanitize(text) {
    const div = document.createElement("div");
    div.innerText = String(text ?? "");
    return div.innerHTML;
}

function csv(value) {
    return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

function getChipValues(group) {
    if (!group) return ["Any"];
    const values = Array.from(group.querySelectorAll(".admin-chip.active")).map((chip) => chip.dataset.value || chip.innerText.trim());
    return values.length ? values : ["Any"];
}

function getInputNumber(input) {
    return Number(input?.value) || 0;
}

function setChipValues(group, values) {
    if (!group) return;
    const normalized = (Array.isArray(values) ? values : [values]).map((value) => String(value || "Any").toLowerCase());
    group.querySelectorAll(".admin-chip").forEach((chip) => {
        const value = String(chip.dataset.value || chip.innerText).toLowerCase();
        chip.classList.toggle("active", normalized.includes(value));
    });
    if (!group.querySelector(".admin-chip.active")) {
        group.querySelector('[data-value="Any"]')?.classList.add("active");
    }
}

function clearForm() {
    const d = dom();
    state.editingId = null;
    d.id.value = "";
    d.title.value = "";
    d.description.value = "";
    setChipValues(d.goalGroup, ["Any"]);
    setChipValues(d.muscleGroup, ["Any"]);
    d.level.value = "Any";
    if (d.intensity) d.intensity.value = 0;
    if (d.recovery) d.recovery.value = 0;
    if (d.reps) d.reps.value = 0;
    d.priority.value = 1;
    d.save.innerText = "Save Rule";
}

function openModal(rule = null) {
    const d = dom();
    clearForm();
    if (rule) {
        state.editingId = rule.id;
        d.id.value = rule.id;
        d.title.value = rule.title;
        d.description.value = rule.description;
        setChipValues(d.goalGroup, rule.targetFitnessGoals || rule.targetFitnessGoal);
        setChipValues(d.muscleGroup, rule.targetMuscleGroups || rule.targetMuscleGroup);
        d.level.value = rule.targetFitnessLevel;
        if (d.intensity) d.intensity.value = rule.intensityModifier;
        if (d.recovery) d.recovery.value = rule.recoveryModifier;
        if (d.reps) d.reps.value = rule.repModifier;
        d.priority.value = rule.priorityLevel >= 3 ? 3 : 1;
        d.save.innerText = "Update Rule";
    }
    d.modal.style.display = "flex";
}

function closeModal() {
    dom().modal.style.display = "none";
    clearForm();
}

function getPayload() {
    const d = dom();
    return {
        title: d.title.value.trim(),
        description: d.description.value.trim(),
        targetFitnessGoals: getChipValues(d.goalGroup),
        targetMuscleGroups: getChipValues(d.muscleGroup),
        targetFitnessGoal: getChipValues(d.goalGroup)[0],
        targetMuscleGroup: getChipValues(d.muscleGroup)[0],
        targetFitnessLevel: d.level.value,
        progressionModifier: getInputNumber(d.reps),
        intensityModifier: getInputNumber(d.intensity),
        recoveryModifier: getInputNumber(d.recovery),
        fatigueModifier: 0,
        optionalExerciseAdditions: [],
        optionalExerciseRemovals: [],
        setModifier: 0,
        repModifier: getInputNumber(d.reps),
        priorityLevel: Number(d.priority.value) >= 3 ? 3 : 1,
        priorityLabel: Number(d.priority.value) >= 3 ? "High" : "Low",
        active: state.editingId ? state.rules.find((rule) => rule.id === state.editingId)?.active !== false : true
    };
}

function validate(payload) {
    if (!payload.title || !payload.description) return "Please add a rule title and description.";
    if (!payload.targetFitnessGoals.length || !payload.targetMuscleGroups.length) return "Select at least one goal and one focus target.";
    if (Math.abs(payload.repModifier) > 20 || Math.abs(payload.progressionModifier) > 20) return "Rep/progression modifiers must stay within 20%.";
    if (Math.abs(payload.intensityModifier) > 25) return "Intensity modifier must stay within 25%.";
    if (Math.abs(payload.recoveryModifier) > 25) return "Recovery modifier must stay within 25%.";
    return "";
}

async function saveRule() {
    const d = dom();
    const payload = getPayload();
    const error = validate(payload);
    if (error) {
        window.alert(error);
        return;
    }

    d.save.disabled = true;
    try {
        if (state.editingId) {
            await updateDoc(doc(db, "ai_rules", state.editingId), {
                ...payload,
                ruleId: state.editingId,
                updatedAt: serverTimestamp()
            });
        } else {
            const ref = await addDoc(collection(db, "ai_rules"), {
                ...payload,
                ruleId: "",
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp()
            });
            await updateDoc(ref, { ruleId: ref.id });
        }
        closeModal();
    } catch (saveError) {
        console.error("Failed to save AI rule:", saveError);
        window.alert("Failed to save rule. Check Firestore permissions.");
    } finally {
        d.save.disabled = false;
    }
}

async function toggleRule(rule) {
    await updateDoc(doc(db, "ai_rules", rule.id), {
        active: !rule.active,
        updatedAt: serverTimestamp()
    });
}

function openDeleteModal(rule) {
    if (!rule) return;
    const d = dom();
    state.deletingId = rule.id;
    if (d.deleteName) d.deleteName.innerText = rule.title;
    if (d.deleteModal) d.deleteModal.style.display = "flex";
}

function closeDeleteModal() {
    const d = dom();
    state.deletingId = null;
    if (d.deleteModal) d.deleteModal.style.display = "none";
}

async function deleteRule() {
    if (!state.deletingId) return;
    await deleteDoc(doc(db, "ai_rules", state.deletingId));
    closeDeleteModal();
}

function renderRules() {
    const list = dom().list;
    if (!list) return;
    if (!state.rules.length) {
        list.innerHTML = `<tr><td colspan="4" style="text-align:center; color:#888;">No AI rules configured yet.</td></tr>`;
        return;
    }

    list.innerHTML = state.rules.map((rule) => `
        <tr>
            <td class="desc-col">
                <strong>${sanitize(rule.title)}</strong>
                <div style="font-size:12px; color:#666; margin-top:4px;">
                    Goals: ${sanitize((rule.targetFitnessGoals || [rule.targetFitnessGoal]).join(", "))} & Focus: ${sanitize((rule.targetMuscleGroups || [rule.targetMuscleGroup]).join(", "))} & Level: ${sanitize(rule.targetFitnessLevel)} -> ${sanitize(rule.description)}
                </div>
            </td>
            <td class="col-center">${rule.priorityLevel >= 3 ? "High" : "Low"}</td>
            <td class="col-center"><span class="status-pill ${rule.active ? "active" : "inactive"}">${rule.active ? "Active" : "Inactive"}</span></td>
            <td class="col-center">
                <button class="text-btn-toggle" data-toggle="${rule.id}">${rule.active ? "Deactivate" : "Activate"}</button>
                <button class="text-btn-edit edit-rule-btn" data-edit="${rule.id}">✎</button>
                <button class="text-btn-delete" data-delete="${rule.id}">🗑</button>
            </td>
        </tr>
    `).join("");

    list.querySelectorAll("[data-toggle]").forEach((btn) => btn.addEventListener("click", () => toggleRule(state.rules.find((rule) => rule.id === btn.dataset.toggle))));
    list.querySelectorAll("[data-edit]").forEach((btn) => btn.addEventListener("click", () => openModal(state.rules.find((rule) => rule.id === btn.dataset.edit))));
    list.querySelectorAll("[data-delete]").forEach((btn) => btn.addEventListener("click", () => openDeleteModal(state.rules.find((rule) => rule.id === btn.dataset.delete))));
}

function renderNotifications() {
    const list = document.querySelector("#notifDropdown .notif-list");
    const badge = document.getElementById("notifBadge");
    if (!list || !badge) return;
    const unread = state.notifications.filter((item) => item.read === false).length;
    badge.innerText = String(unread);
    badge.style.display = unread > 0 ? "inline-flex" : "none";
    list.innerHTML = state.notifications.length
        ? state.notifications.map((item) => `<div class="notif-item ${item.read === false ? "new" : "old"}" data-unread="${item.read === false}"><span class="indicator"></span><div class="notif-text">${item.message || "Admin activity recorded."}</div></div>`).join("")
        : `<div class="notif-item old"><span class="indicator"></span><div class="notif-text">No notifications yet.</div></div>`;
}

function subscribeRules() {
    return onSnapshot(query(collection(db, "ai_rules"), orderBy("priorityLevel", "desc")), (snapshot) => {
        state.rules = snapshot.docs.map((docSnap) => normalizeRule({ id: docSnap.id, ...docSnap.data() }, docSnap.id));
        renderRules();
    }, (error) => {
        console.error("AI rules subscription failed:", error);
        dom().list.innerHTML = `<tr><td colspan="4" style="text-align:center; color:#e63946;">Failed to load rules.</td></tr>`;
    });
}

function wire() {
    const d = dom();
    if (d.addBtn) d.addBtn.addEventListener("click", () => openModal());
    if (d.close) d.close.addEventListener("click", closeModal);
    if (d.save) d.save.addEventListener("click", saveRule);
    if (d.closeDelete) d.closeDelete.addEventListener("click", closeDeleteModal);
    if (d.cancelDelete) d.cancelDelete.addEventListener("click", closeDeleteModal);
    if (d.confirmDelete) d.confirmDelete.addEventListener("click", deleteRule);
    if (d.modal) d.modal.addEventListener("click", (event) => {
        if (event.target === d.modal) closeModal();
    });
    if (d.deleteModal) d.deleteModal.addEventListener("click", (event) => {
        if (event.target === d.deleteModal) closeDeleteModal();
    });
    document.querySelectorAll("#ruleGoalGroup .admin-chip, #ruleMuscleGroup .admin-chip").forEach((chip) => {
        chip.addEventListener("click", () => {
            const group = chip.closest(".chip-container");
            const value = chip.dataset.value || chip.innerText.trim();
            const isFocusGroup = group?.id === "ruleMuscleGroup";
            if (value === "Any") {
                group.querySelectorAll(".admin-chip").forEach((item) => item.classList.remove("active"));
                chip.classList.add("active");
                return;
            }
            if (isFocusGroup && value === "Full Body") {
                group.querySelectorAll(".admin-chip").forEach((item) => item.classList.remove("active"));
                chip.classList.add("active");
                return;
            }
            group.querySelector('[data-value="Any"]')?.classList.remove("active");
            if (isFocusGroup) group.querySelector('[data-value="Full Body"]')?.classList.remove("active");
            chip.classList.toggle("active");
            if (!group.querySelector(".admin-chip.active")) group.querySelector('[data-value="Any"]')?.classList.add("active");
        });
    });
    const notifBtn = document.getElementById("notifBtn");
    if (notifBtn) notifBtn.addEventListener("click", () => {
        notificationOpenCount += 1;
        if (notificationOpenCount >= 2) setTimeout(() => markNotificationsRead(state.notifications), 0);
    });
}

document.addEventListener("DOMContentLoaded", () => {
    wire();
    onAuthStateChanged(auth, (user) => {
        if (!user || user.email !== "admin@denio.app") {
            window.location.href = "../profile/admin-login.html";
            return;
        }
        subscribeRules();
    });
    const logoutBtn = document.getElementById("adminLogoutBtn");
    if (logoutBtn) logoutBtn.addEventListener("click", async (event) => {
        event.preventDefault();
        await signOut(auth);
        window.location.href = "../profile/admin-login.html";
    });
    listenToAdminNotifications((notifications) => {
        state.notifications = notifications;
        renderNotifications();
    });
});
