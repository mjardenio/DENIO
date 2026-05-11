import { db } from "./firebase.js";
import { collection, getDocs, onSnapshot } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

const CACHE_KEY = "denio_library_cache_v4";
const CACHE_TTL_MS = 1000 * 60 * 30;
const DENIO_GROUPS = ["Chest", "Back", "Arms", "Legs", "Shoulders", "Abs", "Glutes", "Full Body"];

function normalizeMuscleGroup(rawValue, secondaryRaw = "") {
    const source = `${rawValue || ""} ${secondaryRaw || ""}`.toLowerCase();
    if (source.includes("chest") || source.includes("pector")) return "Chest";
    if (source.includes("back") || source.includes("lat") || source.includes("trap")) return "Back";
    if (source.includes("arm") || source.includes("biceps") || source.includes("triceps") || source.includes("forearm")) return "Arms";
    if (source.includes("leg") || source.includes("quad") || source.includes("hamstring") || source.includes("calf")) return "Legs";
    if (source.includes("shoulder") || source.includes("deltoid")) return "Shoulders";
    if (source.includes("abs") || source.includes("core") || source.includes("oblique")) return "Abs";
    if (source.includes("glute") || source.includes("hip")) return "Glutes";
    return "Full Body";
}

function normalizeExercise(raw, source = "firestore", fallbackId = "") {
    const primary = raw.muscle_group || raw.primary_muscle || raw.primaryMuscle || raw.mainMuscle || "";
    const secondary = raw.secondary_muscle || raw.secondaryMuscle || raw.secondary || "";
    const muscleGroup = normalizeMuscleGroup(primary, secondary);
    const name = raw.name || raw.exercise_name || "Unnamed Exercise";
    const difficulty = String(raw.difficulty_level || raw.level || "Beginner");
    const reps = String(raw.recommended_reps || raw.reps || "8-12");
    const setsRaw = Number.parseInt(raw.recommended_sets ?? raw.sets ?? 3, 10);

    return {
        id: raw.id || raw.exercise_id || fallbackId || `${name}-${muscleGroup}`.replace(/\s+/g, "-").toLowerCase(),
        name,
        muscle_group: muscleGroup,
        secondary_muscle_group: secondary || "None",
        difficulty_level: difficulty,
        description: raw.description || raw.instructions || "No description available.",
        form_tips: raw.form_tips || raw.advice || "Control each rep and maintain form.",
        equipment_needed: raw.equipment_needed || raw.equipment || "Bodyweight",
        gif_url: raw.gif_url || raw.image || raw.images?.[0] || "",
        recommended_sets: Number.isFinite(setsRaw) && setsRaw > 0 ? setsRaw : 3,
        recommended_reps: reps,
        calories_estimate: Number(raw.calories_estimate ?? raw.calories ?? 45) || 45,
        mistakes_to_avoid: raw.mistakes_to_avoid || "Avoid rushing reps and compromising range of motion.",
        source
    };
}

function isExerciseComplete(exercise) {
    return String(exercise?.name || "").trim().toLowerCase() !== "unknown exercise";
}

function debounce(fn, delay = 250) {
    let timer = null;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), delay);
    };
}

function readCache(cacheKey = CACHE_KEY) {
    try {
        const raw = localStorage.getItem(cacheKey);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed?.createdAt || !Array.isArray(parsed.items)) return null;
        const isExpired = Date.now() - parsed.createdAt > CACHE_TTL_MS;
        return isExpired ? null : parsed.items;
    } catch (error) {
        console.error("Cache read failed:", error);
        return null;
    }
}

function writeCache(items, cacheKey = CACHE_KEY) {
    localStorage.setItem(cacheKey, JSON.stringify({ createdAt: Date.now(), items }));
}

async function fetchFirestoreExercises() {
    const snapshot = await getDocs(collection(db, "exercises"));
    return snapshot.docs
        .map((docSnap) => normalizeExercise({ id: docSnap.id, ...docSnap.data() }, "firestore", docSnap.id))
        .filter(isExerciseComplete);
}

export async function initLibraryEngine() {
    const libraryList = document.getElementById("libraryList");
    if (!libraryList) return;

    const filterContainer = document.getElementById("filterContainer");
    let exercises = [];
    let selectedFilter = "All";
    let searchTerm = "";
    let lastRenderSignature = "";

    injectSearchInput(filterContainer);
    injectDetailsModal();

    const cachedExercises = readCache();
    if (cachedExercises?.length) {
        exercises = cachedExercises;
        renderLibrary(exercises, libraryList, selectedFilter, searchTerm, setRenderSignature);
    }

    onSnapshot(collection(db, "exercises"), (snapshot) => {
        exercises = snapshot.docs
            .map((docSnap) => normalizeExercise({ id: docSnap.id, ...docSnap.data() }, "firestore", docSnap.id))
            .filter(isExerciseComplete)
            .sort((a, b) => a.name.localeCompare(b.name));
        writeCache(exercises);
        renderLibrary(exercises, libraryList, selectedFilter, searchTerm, setRenderSignature);
    }, (error) => {
        console.error("Error loading exercise library:", error);
        if (!cachedExercises?.length) {
            libraryList.innerHTML = '<div style="color: #e63946; text-align: center; padding:20px;">Failed to load exercise library.</div>';
        }
    });

    window.applyFilter = function applyFilter(category) {
        selectedFilter = category;
        document.querySelectorAll(".filter-pill").forEach((btn) => {
            if (btn.innerText === category) btn.classList.add("active");
            else btn.classList.remove("active");
        });
        renderLibrary(exercises, libraryList, selectedFilter, searchTerm, setRenderSignature);
    };

    const searchInput = document.getElementById("librarySearchInput");
    if (searchInput) {
        searchInput.addEventListener("input", debounce((event) => {
            searchTerm = event.target.value.trim().toLowerCase();
            renderLibrary(exercises, libraryList, selectedFilter, searchTerm, setRenderSignature);
        }, 220));
    }

    function setRenderSignature(signature) {
        lastRenderSignature = signature;
    }

    function renderLibrary(items, root, filter, query, setSignature) {
        const filtered = items.filter((exercise) => {
            const filterMatch = filter === "All" || exercise.muscle_group === filter;
            const searchMatch = !query || exercise.name.toLowerCase().includes(query);
            return filterMatch && searchMatch;
        }).sort((a, b) => a.name.localeCompare(b.name));

        const signature = `${filter}|${query}|${filtered.map((item) => [
            item.id,
            item.name,
            item.gif_url,
            item.description,
            item.form_tips,
            item.equipment_needed,
            item.muscle_group
        ].join("~")).join(",")}`;
        if (signature === lastRenderSignature) return;
        setSignature(signature);

        if (!filtered.length) {
            root.innerHTML = '<div style="text-align:center; color:#888; padding:20px;">No exercises match your filter.</div>';
            return;
        }

        root.innerHTML = "";
        const fragment = document.createDocumentFragment();
        filtered.forEach((exercise) => {
            const card = document.createElement("div");
            card.className = "exercise-card";
            card.setAttribute("data-category", exercise.muscle_group);
            card.style.cursor = "pointer";
            card.innerHTML = `
                <div class="exercise-visual">
                    <img src="${exercise.gif_url}" alt="${exercise.name}"
                         onerror="this.onerror=null; this.src='https://ui-avatars.com/api/?name=${encodeURIComponent(exercise.name)}&background=262626&color=e63946&size=150&rounded=true';"
                         loading="lazy"
                         style="width:100%; height:100%; object-fit:cover; border-radius:8px; display:block; background:#222;">
                </div>
                <div class="exercise-info">
                    <div class="ex-title">${exercise.name}</div>
                    <div class="ex-tag">${exercise.muscle_group}</div>
                    <div class="ex-desc" style="font-size:12px; color:#aaa; margin-top:4px;">
                        ${exercise.description}
                    </div>
                </div>
            `;
            card.addEventListener("click", () => openExerciseModal(exercise));
            fragment.appendChild(card);
        });
        root.appendChild(fragment);
    }
}

function injectSearchInput(filterContainer) {
    if (!filterContainer || document.getElementById("librarySearchInput")) return;
    const searchWrap = document.createElement("div");
    searchWrap.style.flex = "1";
    searchWrap.style.flexBasis = "100%";
    searchWrap.style.minWidth = "150px";
    searchWrap.innerHTML = `
        <input
            id="librarySearchInput"
            type="text"
            placeholder="Search exercise..."
            style="width:100%; background:#1a1a1a; border:1px solid #333; color:#fff; border-radius:18px; padding:8px 12px; font-size:12px;"
        />
    `;
    filterContainer.appendChild(searchWrap);
}

function injectDetailsModal() {
    if (document.getElementById("libraryDetailsModal")) return;
    const modal = document.createElement("div");
    modal.id = "libraryDetailsModal";
    modal.style.position = "fixed";
    modal.style.inset = "0";
    modal.style.background = "rgba(0,0,0,0.85)";
    modal.style.display = "none";
    modal.style.alignItems = "center";
    modal.style.justifyContent = "center";
    modal.style.zIndex = "999";
    modal.style.padding = "18px";
    modal.innerHTML = `
        <div style="width:100%; max-width:410px; max-height:85vh; overflow-y:auto; background:#111; border:1px solid #333; border-radius:14px; padding:14px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
                <strong id="libModalTitle" style="color:#fff; font-size:16px;"></strong>
                <button id="libModalCloseBtn" style="background:none; border:none; color:#e63946; font-size:20px; cursor:pointer;">✖</button>
            </div>
            <img id="libModalImg" src="" alt="Exercise media" style="width:100%; height:180px; object-fit:contain; border-radius:10px; background:#222; margin-bottom:10px;" loading="lazy" />
            <div style="font-size:12px; color:#aaa; line-height:1.5;">
                <div><strong style="color:#fff;">Primary:</strong> <span id="libModalPrimary"></span></div>
                <div><strong style="color:#fff;">Equipment:</strong> <span id="libModalEquipment"></span></div>
                <div style="margin-top:8px;"><strong style="color:#fff;">Description:</strong> <span id="libModalDescription"></span></div>
                <div style="margin-top:8px;"><strong style="color:#fff;">Form Tips:</strong> <span id="libModalTips"></span></div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    document.getElementById("libModalCloseBtn").addEventListener("click", () => {
        modal.style.display = "none";
    });
    modal.addEventListener("click", (event) => {
        if (event.target === modal) modal.style.display = "none";
    });
}

function openExerciseModal(exercise) {
    const modal = document.getElementById("libraryDetailsModal");
    if (!modal) return;
    document.getElementById("libModalTitle").innerText = exercise.name;
    const img = document.getElementById("libModalImg");
    img.src = exercise.gif_url || "";
    img.onerror = () => {
        img.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(exercise.name)}&background=262626&color=e63946&size=300&rounded=true`;
    };
    document.getElementById("libModalPrimary").innerText = exercise.muscle_group;
    document.getElementById("libModalEquipment").innerText = exercise.equipment_needed;
    document.getElementById("libModalDescription").innerText = exercise.description;
    document.getElementById("libModalTips").innerText = exercise.form_tips;
    modal.style.display = "flex";
}

export { normalizeExercise, normalizeMuscleGroup, DENIO_GROUPS, isExerciseComplete };
