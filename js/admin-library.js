// js/admin-library.js

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
import { normalizeExercise, isExerciseComplete } from "./library-engine.js";
import { createAdminNotification, listenToAdminNotifications, markNotificationsRead } from "./admin-services.js";
import { normalizeEquipmentList } from "./adaptive-engine.js";

const state = {
    exercises: [],
    filtered: [],
    editingId: null,
    selectedMuscles: new Set(),
    searchTerm: "",
    pendingDeleteId: null,
    notifications: []
};
let notificationOpenCount = 0;

function getDom() {
    return {
        list: document.getElementById("adminExerciseList"),
        search: document.getElementById("adminExerciseSearch") || document.querySelector(".admin-input-search"),
        modal: document.getElementById("exerciseModal"),
        modalTitle: document.getElementById("exerciseModalTitle"),
        closeBtn: document.getElementById("closeExModal"),
        saveBtn: document.getElementById("saveExerciseBtn"),
        id: document.getElementById("adminExerciseId"),
        name: document.getElementById("adminExerciseName"),
        primary: document.getElementById("adminPrimaryMuscle"),
        equipment: document.getElementById("adminExerciseEquipment"),
        equipmentGroup: document.getElementById("adminExerciseEquipmentGroup"),
        url: document.getElementById("adminExUrl"),
        description: document.getElementById("adminExerciseDescription"),
        tips: document.getElementById("adminExerciseTips"),
        addBtn: document.getElementById("addExerciseBtn"),
        filterBtn: document.getElementById("muscleFilterBtn"),
        filterMenu: document.getElementById("muscleFilterMenu"),
        deleteModal: document.getElementById("deleteExerciseModal"),
        deleteName: document.getElementById("deleteExerciseName"),
        confirmDelete: document.getElementById("confirmDeleteExerciseBtn"),
        cancelDelete: document.getElementById("cancelDeleteExerciseBtn"),
        closeDelete: document.getElementById("closeDeleteExerciseModal")
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

function getExerciseNameKey(name) {
    return String(name || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function setSelectValue(select, value) {
    const normalizedList = normalizeEquipmentList(value);
    const normalized = normalizedList.join(", ");
    if (!select) return;
    if (!select.options) {
        select.value = normalized;
        document.querySelectorAll("#adminExerciseEquipmentGroup .admin-chip").forEach((chip) => {
            chip.classList.toggle("active", normalizedList.includes(chip.dataset.value || chip.innerText.trim()));
        });
        return;
    }
    const hasOption = Array.from(select.options).some((option) => option.value === normalized || option.text === normalized);
    if (normalized && !hasOption) select.add(new Option(normalized, normalized));
    select.value = normalized;
}

function normalizeAdminExercise(docSnap) {
    const data = { id: docSnap.id, ...docSnap.data() };
    const normalized = normalizeExercise(data, "firestore", docSnap.id);
    return {
        ...normalized,
        exerciseId: data.exerciseId || data.exercise_id || docSnap.id,
        raw: data,
        primary_muscle: data.primary_muscle || data.primaryMuscle || normalized.muscle_group,
        equipment: data.equipment || data.equipment_needed || normalized.equipment_needed,
        form_tips: data.form_tips || data.formTips || data.advice || normalized.form_tips,
        gif_url: data.gif_url || data.image_url || data.image || normalized.gif_url,
        createdAt: data.createdAt || data.created_at || null,
        updatedAt: data.updatedAt || data.updated_at || null
    };
}

function getSelectedExercise(id) {
    return state.exercises.find((exercise) => exercise.id === id);
}

function getFormPayload() {
    const dom = getDom();
    const name = dom.name.value.trim().replace(/\s+/g, " ");
    const primaryMuscle = dom.primary.value.trim();
    const equipment = normalizeEquipmentList(dom.equipment.value);
    const description = dom.description.value.trim();
    const formTips = dom.tips.value.trim();
    const gifUrl = dom.url.value.trim();

    return {
        name,
        exerciseId: state.editingId || "",
        primary_muscle: primaryMuscle,
        muscle_group: primaryMuscle,
        equipment,
        equipment_needed: equipment,
        description,
        form_tips: formTips,
        advice: formTips,
        gif_url: gifUrl,
        image_url: gifUrl
    };
}

function validatePayload(payload) {
    if (!payload.name || !payload.primary_muscle || !payload.equipment.length || !payload.description || !payload.form_tips || !payload.gif_url) {
        return "Please fill in Exercise Name, Primary Muscle, Equipment, Description, Form Tips, and GIF/Image URL.";
    }

    try {
        const parsed = new URL(payload.gif_url);
        if (!["http:", "https:"].includes(parsed.protocol)) return "GIF/Image URL must be a valid web link.";
    } catch {
        return "GIF/Image URL must be a valid web link.";
    }

    const nameKey = getExerciseNameKey(payload.name);
    const duplicate = state.exercises.find((exercise) =>
        getExerciseNameKey(exercise.name) === nameKey && exercise.id !== state.editingId
    );
    if (duplicate) return "An exercise with this name already exists.";
    return "";
}

function clearForm() {
    const dom = getDom();
    state.editingId = null;
    dom.id.value = "";
    dom.name.value = "";
    dom.primary.value = "";
    dom.equipment.value = "";
    dom.equipmentGroup?.querySelectorAll(".admin-chip").forEach((chip) => chip.classList.remove("active"));
    dom.url.value = "";
    dom.description.value = "";
    dom.tips.value = "";
    dom.modalTitle.innerText = "Add Exercise";
    dom.saveBtn.innerText = "Save Exercise";
}

function openModal(mode, exercise = null) {
    const dom = getDom();
    clearForm();

    if (mode === "edit" && exercise) {
        state.editingId = exercise.id;
        dom.id.value = exercise.id;
        dom.name.value = exercise.name || "";
        dom.primary.value = exercise.primary_muscle || exercise.muscle_group || "";
        setSelectValue(dom.equipment, exercise.equipment || exercise.equipment_needed || "");
        dom.url.value = exercise.gif_url || "";
        dom.description.value = exercise.description || "";
        dom.tips.value = exercise.form_tips || "";
        dom.modalTitle.innerText = "Edit Exercise";
        dom.saveBtn.innerText = "Update Exercise";
    }

    dom.modal.style.display = "flex";
}

function closeModal() {
    const dom = getDom();
    dom.modal.style.display = "none";
    clearForm();
}

function applyFilters() {
    const selected = [...state.selectedMuscles];
    state.filtered = state.exercises.filter((exercise) => {
        const matchesSearch = !state.searchTerm || exercise.name.toLowerCase().includes(state.searchTerm);
        const matchesMuscle = !selected.length || selected.includes(exercise.muscle_group);
        return matchesSearch && matchesMuscle;
    });
    renderExercises();
}

function renderDetailsModal(exercise) {
    openModal("edit", exercise);
}

function renderExercises() {
    const { list } = getDom();
    if (!list) return;

    if (!state.filtered.length) {
        list.innerHTML = '<tr><td colspan="4" style="text-align: center; color: #aaa;">No exercises found.</td></tr>';
        return;
    }

    const fragment = document.createDocumentFragment();
    list.innerHTML = "";

    state.filtered.forEach((exercise) => {
        const row = document.createElement("tr");
        row.style.cursor = "default";
        row.innerHTML = `
            <td>
                <div class="exercise-cell" style="display:flex; align-items:center; gap:10px;">
                    <img src="${sanitize(exercise.gif_url)}"
                         onerror="this.onerror=null; this.src='https://ui-avatars.com/api/?name=${encodeURIComponent(exercise.name)}&background=ffffff&color=e63946&size=150&rounded=true';"
                         loading="lazy"
                         class="exercise-img-box" alt="GIF" style="width: 40px; height: 40px; border-radius: 6px; object-fit: cover; border: 1px solid #eee; background: #f9f9f9;">
                    <strong style="color: #333;">${sanitize(exercise.name)}</strong>
                </div>
            </td>
            <td class="desc-col" style="color: #666; font-size: 13px;">${sanitize(exercise.description)}</td>
            <td class="col-center"><div class="muscle-circle" style="background:rgba(230, 57, 70, 0.1); color:#e63946; padding:4px 10px; border-radius:12px; display:inline-block; font-size:12px; font-weight:bold;">${sanitize(exercise.muscle_group)}</div></td>
            <td class="col-center">
                <button class="text-btn-edit edit-ex-btn" data-edit="${exercise.id}" style="background:none; border:none; font-size:18px; cursor:pointer; margin-right:10px;">✎</button>
                <button class="text-btn-delete" data-delete="${exercise.id}" style="background:none; border:none; color:#e63946; font-size:18px; cursor:pointer;">✖</button>
            </td>
        `;
        row.querySelector("[data-edit]").addEventListener("click", (event) => {
            event.stopPropagation();
            openModal("edit", exercise);
        });
        row.querySelector("[data-delete]").addEventListener("click", (event) => {
            event.stopPropagation();
            openDeleteModal(exercise.id);
        });
        fragment.appendChild(row);
    });

    list.appendChild(fragment);
}

async function saveExercise() {
    const dom = getDom();
    const payload = getFormPayload();
    const validationError = validatePayload(payload);
    if (validationError) {
        window.alert(validationError);
        return;
    }

    dom.saveBtn.disabled = true;
    dom.saveBtn.innerText = state.editingId ? "Updating..." : "Saving...";

    try {
        if (state.editingId) {
            await updateDoc(doc(db, "exercises", state.editingId), {
                ...payload,
                exerciseId: state.editingId,
                updatedAt: serverTimestamp(),
                updated_at: serverTimestamp()
            });
        } else {
            const docRef = await addDoc(collection(db, "exercises"), {
                ...payload,
                exerciseId: "",
                createdAt: serverTimestamp(),
                created_at: serverTimestamp(),
                updatedAt: serverTimestamp(),
                updated_at: serverTimestamp()
            });
            await updateDoc(docRef, {
                exerciseId: docRef.id,
                exercise_id: docRef.id
            });
        }
        closeModal();
    } catch (error) {
        console.error("Exercise save failed:", error);
        window.alert("Failed to save exercise. Please check Firestore permissions.");
    } finally {
        dom.saveBtn.disabled = false;
        dom.saveBtn.innerText = state.editingId ? "Update Exercise" : "Save Exercise";
    }
}

function openDeleteModal(id) {
    const exercise = getSelectedExercise(id);
    if (!exercise) return;
    const dom = getDom();
    state.pendingDeleteId = id;
    if (dom.deleteName) dom.deleteName.innerText = exercise.name;
    if (dom.deleteModal) dom.deleteModal.style.display = "flex";
}

function closeDeleteModal() {
    const dom = getDom();
    state.pendingDeleteId = null;
    if (dom.deleteModal) dom.deleteModal.style.display = "none";
}

async function deleteExercise() {
    const id = state.pendingDeleteId;
    if (!id) return;

    try {
        state.exercises = state.exercises.filter((item) => item.id !== id);
        closeDeleteModal();
        applyFilters();
        await deleteDoc(doc(db, "exercises", id));
    } catch (error) {
        console.error("Delete error:", error);
        window.alert("Failed to delete exercise.");
        subscribeExercises();
    }
}

function subscribeExercises() {
    const { list } = getDom();
    if (list) list.innerHTML = '<tr><td colspan="4" style="text-align: center; color: #888;">Loading database...</td></tr>';

    try {
        return onSnapshot(query(collection(db, "exercises"), orderBy("name")), (snapshot) => {
            state.exercises = snapshot.docs
                .map(normalizeAdminExercise)
                .filter(isExerciseComplete);
            applyFilters();
        }, (error) => {
            console.error("Admin exercise realtime error:", error);
            if (list) list.innerHTML = '<tr><td colspan="4" style="text-align: center; color: #e63946;">Error loading database.</td></tr>';
        });
    } catch (error) {
        console.error("Admin exercise subscription failed:", error);
        if (list) list.innerHTML = '<tr><td colspan="4" style="text-align: center; color: #e63946;">Error loading database.</td></tr>';
        return () => {};
    }
}

function wireControls() {
    const dom = getDom();

    if (dom.addBtn) dom.addBtn.addEventListener("click", () => openModal("add"));
    if (dom.closeBtn) dom.closeBtn.addEventListener("click", closeModal);
    if (dom.saveBtn) dom.saveBtn.addEventListener("click", saveExercise);
    if (dom.cancelDelete) dom.cancelDelete.addEventListener("click", closeDeleteModal);
    if (dom.closeDelete) dom.closeDelete.addEventListener("click", closeDeleteModal);
    if (dom.confirmDelete) dom.confirmDelete.addEventListener("click", deleteExercise);
    if (dom.modal) {
        dom.modal.addEventListener("click", (event) => {
            if (event.target === dom.modal) closeModal();
        });
    }
    if (dom.equipmentGroup) {
        dom.equipmentGroup.querySelectorAll(".admin-chip").forEach((chip) => {
            chip.addEventListener("click", () => {
                const value = chip.dataset.value || chip.innerText.trim();
                const isExclusive = value === "FULL GYM" || value === "NONE";
                if (isExclusive) {
                    if (chip.classList.contains("active")) {
                        chip.classList.remove("active");
                    } else {
                        dom.equipmentGroup.querySelectorAll(".admin-chip").forEach((item) => item.classList.remove("active"));
                        chip.classList.add("active");
                    }
                } else {
                    dom.equipmentGroup.querySelectorAll(".admin-chip").forEach((item) => {
                        const itemValue = item.dataset.value || item.innerText.trim();
                        if (itemValue === "FULL GYM" || itemValue === "NONE") item.classList.remove("active");
                    });
                    chip.classList.toggle("active");
                }
                dom.equipment.value = Array.from(dom.equipmentGroup.querySelectorAll(".admin-chip.active"))
                    .map((item) => item.dataset.value || item.innerText.trim())
                    .join(", ");
            });
        });
    }
    if (dom.deleteModal) {
        dom.deleteModal.addEventListener("click", (event) => {
            if (event.target === dom.deleteModal) closeDeleteModal();
        });
    }

    if (dom.search) {
        dom.search.addEventListener("input", debounce((event) => {
            state.searchTerm = event.target.value.trim().toLowerCase();
            applyFilters();
        }));
    }

    document.querySelectorAll(".lib-filter-chip").forEach((chip) => {
        chip.addEventListener("click", (event) => {
            event.stopPropagation();
            const muscle = chip.innerText.trim();
            if (state.selectedMuscles.has(muscle)) {
                state.selectedMuscles.delete(muscle);
                chip.classList.remove("active");
            } else {
                state.selectedMuscles.add(muscle);
                chip.classList.add("active");
            }
            applyFilters();
        });
    });

    const notifBtn = document.getElementById("notifBtn");
    if (notifBtn) {
        notifBtn.addEventListener("click", () => {
            notificationOpenCount += 1;
            if (notificationOpenCount >= 2) setTimeout(() => markNotificationsRead(state.notifications), 0);
        });
    }

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

function initAdminAuth() {
    onAuthStateChanged(auth, (user) => {
        if (!user || user.email !== "admin@denio.app") {
            window.location.href = "../profile/admin-login.html";
            return;
        }
        subscribeExercises();
    });
}

document.addEventListener("DOMContentLoaded", () => {
    if (!document.getElementById("adminExerciseList")) return;
    wireControls();
    initAdminAuth();
    listenToAdminNotifications((notifications) => {
        state.notifications = notifications;
        renderNotifications();
    });
});
