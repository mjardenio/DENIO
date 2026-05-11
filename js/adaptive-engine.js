import { db } from "./firebase.js";
import {
    addDoc,
    collection,
    doc,
    getDoc,
    getDocs,
    limit,
    orderBy,
    query,
    serverTimestamp,
    setDoc,
    updateDoc,
    where
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

const MUSCLES = ["Chest", "Back", "Legs", "Shoulders", "Arms", "Abs", "Glutes", "Full Body"];
export const DENIO_EQUIPMENT_OPTIONS = ["FULL GYM", "BARBELLS", "DUMBBELLS", "KETTLE BELLS", "MACHINES", "NONE"];
const RULE_CACHE_TTL_MS = 1000 * 30;
let ruleCache = { createdAt: 0, rules: [] };

export const LEVEL_SCALING = {
    beginner: { sets: 3, repBoost: 0, intensity: 0.85, progression: 0.75, maxExercises: 4 },
    intermediate: { sets: 4, repBoost: 2, intensity: 1, progression: 1, maxExercises: 5 },
    advanced: { sets: 4, repBoost: 4, intensity: 1.18, progression: 1.25, maxExercises: 6 }
};

export const COACH_JAY_MESSAGE_POOLS = {
    dailyMotivation: [
        "Show up with intent today. One clean session keeps the habit alive.",
        "Small progress counts when you repeat it. Start strong.",
        "Your future strength is built by today's boring consistency.",
        "You do not need a perfect day. You need an honest session.",
        "Win the warm-up, then win the first set.",
        "Momentum is available today. Take it one set at a time.",
        "Keep your standard simple: move well and finish.",
        "The plan works when you meet it halfway.",
        "Your goals are closer when your routine stays steady.",
        "Train like this session matters, because it does."
    ],
    intenseDiscipline: [
        "No rushed reps. Control is the standard.",
        "Stay strict when fatigue starts negotiating.",
        "Push hard, but do not let effort turn sloppy.",
        "Earn the next level with clean execution.",
        "Focus beats hype. Lock in and work.",
        "The last reps need discipline, not panic.",
        "Your form is the rule. Everything else follows.",
        "Keep tension where it belongs and finish the set.",
        "Do not chase numbers your technique cannot own.",
        "Strong training is controlled training."
    ],
    workoutTips: [
        "Brace before every rep and breathe with the movement.",
        "Use the warm-up to rehearse the same form you want under fatigue.",
        "Rest long enough to make the next set useful.",
        "If the target muscle is not working, slow the tempo down.",
        "Keep your setup consistent before adding difficulty.",
        "Leave one clean rep available when form starts fading.",
        "Track weight honestly so progression stays accurate.",
        "Control the lowering phase instead of dropping into it.",
        "Choose range of motion before chasing load.",
        "Keep your joints stacked and your core steady."
    ],
    congratulatory: [
        "Workout complete. You kept the promise today.",
        "Strong finish. That session is now part of your progress.",
        "You showed up and did the work. Respect that.",
        "Great effort today. Recover like the next session matters.",
        "Another session logged. Consistency is adding up.",
        "Clean work. You earned the win.",
        "That finish matters. Keep this rhythm alive.",
        "Good job staying with the plan until the end.",
        "Session complete. Hydrate, refuel, and reset.",
        "You handled the work. Carry that standard forward."
    ],
    reminder: [
        "Your consistency is strong. Keep the streak protected today.",
        "You have been steady lately. A controlled session keeps that alive.",
        "Recent rhythm looks good. Do not overcomplicate today.",
        "You skipped recently. Restart with one manageable workout.",
        "Accountability time: get one session done before momentum cools.",
        "A missed day is data, not a sentence. Return to the plan.",
        "Protect the habit with a short, focused win.",
        "Your routine needs attention today. Start simple.",
        "Consistency is easier to keep than rebuild. Train today.",
        "If life got messy, keep the workout clean and finishable."
    ],
    exerciseSpecificTips: [
        "For this exercise, set your posture before the first rep.",
        "Keep the target muscle loaded through the full range.",
        "Slow down until you can feel the intended muscle working.",
        "Avoid bouncing. Own the bottom position.",
        "Keep your breathing steady during the hardest reps.",
        "Stop the set if your joints take over from the target muscle.",
        "Use the same path every rep so the set stays measurable.",
        "Keep your core braced and your shoulders controlled.",
        "Do not let momentum steal the stimulus.",
        "Finish each rep before starting the next one."
    ]
};

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, Number(value) || 0));
}

function shuffle(items) {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
}

function toDateSafe(value) {
    if (!value) return null;
    if (typeof value.toDate === "function") return value.toDate();
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getDateKey(value) {
    const date = toDateSafe(value);
    if (!date) return null;
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d.toISOString().slice(0, 10);
}

function normalizeArray(value) {
    if (Array.isArray(value)) return value.filter(Boolean);
    if (!value) return [];
    return [value];
}

export function normalizeEquipmentList(value) {
    const aliasMap = new Map([
        ["FULL GYM", "FULL GYM"],
        ["GYM", "FULL GYM"],
        ["BARBELL", "BARBELLS"],
        ["BARBELLS", "BARBELLS"],
        ["DUMBBELL", "DUMBBELLS"],
        ["DUMBBELLS", "DUMBBELLS"],
        ["KETTLEBELL", "KETTLE BELLS"],
        ["KETTLEBELLS", "KETTLE BELLS"],
        ["KETTLE BELL", "KETTLE BELLS"],
        ["KETTLE BELLS", "KETTLE BELLS"],
        ["MACHINE", "MACHINES"],
        ["MACHINES", "MACHINES"],
        ["CABLE MACHINE", "MACHINES"],
        ["NONE", "NONE"],
        ["NO EQUIPMENT", "NONE"],
        ["BODYWEIGHT", "NONE"]
    ]);
    const normalized = normalizeArray(value)
        .flatMap((item) => String(item || "").split(","))
        .map((item) => aliasMap.get(item.trim().toUpperCase()) || item.trim().toUpperCase())
        .filter((item) => DENIO_EQUIPMENT_OPTIONS.includes(item));
    return [...new Set(normalized)];
}

function normalizeTargetList(value, fallback = "Any") {
    const values = normalizeArray(value).map((item) => String(item).trim()).filter(Boolean);
    return values.length ? values : [fallback];
}

function getLevelKey(userProfile) {
    const raw = String(userProfile?.fitnessLevel || userProfile?.level || "beginner").toLowerCase();
    if (raw.includes("advanced")) return "advanced";
    if (raw.includes("intermediate")) return "intermediate";
    return "beginner";
}

function normalizeExercise(raw, fallbackId = "") {
    const primary = raw.muscle_group || raw.primary_muscle || raw.primaryMuscle || raw.primary || "Full Body";
    const equipment = normalizeEquipmentList(raw.equipment || raw.equipment_needed || raw.equipmentNeeded || "NONE");
    const name = String(raw.name || raw.exercise_name || "").trim();
    return {
        id: raw.id || raw.exercise_id || raw.exerciseId || fallbackId,
        name,
        muscle_group: MUSCLES.includes(primary) ? primary : "Full Body",
        equipment: equipment.length ? equipment : ["NONE"],
        gif_url: raw.gif_url || raw.image_url || raw.image || "",
        description: raw.description || raw.instructions || "Maintain strict form and full range of motion.",
        form_tips: raw.form_tips || raw.advice || "Control each rep and avoid rushing."
    };
}

function isValidLibraryExercise(exercise) {
    return Boolean(exercise?.id && exercise?.name && exercise.name !== "Unknown Exercise");
}

function parseRepRange(repRange) {
    const nums = String(repRange || "8-12").match(/\d+/g)?.map(Number) || [8, 12];
    const min = nums[0] || 8;
    const max = nums[1] || nums[0] || 12;
    return { min, max };
}

function formatRepRange(min, max) {
    return min === max ? String(min) : `${min}-${max}`;
}

function adjustRepRange(repRange, percent) {
    const { min, max } = parseRepRange(repRange);
    const factor = 1 + (clamp(percent, -20, 20) / 100);
    const nextMin = clamp(Math.round(min * factor), 3, 25);
    const nextMax = clamp(Math.round(max * factor), nextMin, 30);
    return formatRepRange(nextMin, nextMax);
}

function getBasePrescription(userProfile) {
    const goals = normalizeArray(userProfile?.goals);
    const levelKey = getLevelKey(userProfile);
    const level = LEVEL_SCALING[levelKey];
    let sets = level.sets;
    let reps = level.repBoost >= 4 ? "8-14" : level.repBoost >= 2 ? "8-12" : "10-12";

    if (goals.includes("Increase Strength")) {
        sets = levelKey === "beginner" ? 3 : levelKey === "intermediate" ? 4 : 5;
        reps = levelKey === "beginner" ? "5-6" : "4-6";
    } else if (goals.includes("Lose Weight") || goals.includes("Tone Body")) {
        reps = levelKey === "advanced" ? "12-18" : "12-15";
    }
    return { sets, reps };
}

function getWeeklySplit(userProfile) {
    const days = Number.parseInt(userProfile?.frequency || userProfile?.workoutFrequency, 10) || 3;
    const splits = {
        1: [["Full Body", "Abs"]],
        2: [["Chest", "Shoulders", "Arms"], ["Legs", "Back", "Abs"]],
        3: [["Chest", "Arms"], ["Back", "Shoulders"], ["Legs", "Abs"]],
        4: [["Chest", "Abs"], ["Back", "Arms"], ["Legs", "Glutes"], ["Shoulders", "Full Body"]],
        5: [["Chest"], ["Back"], ["Legs", "Glutes"], ["Shoulders"], ["Arms", "Abs"]],
        6: [["Chest", "Abs"], ["Back"], ["Legs"], ["Shoulders"], ["Arms"], ["Full Body"]],
        7: [["Chest"], ["Back"], ["Legs"], ["Shoulders"], ["Arms"], ["Abs"], ["Full Body"]]
    };
    return splits[Math.min(7, Math.max(1, days))] || splits[3];
}

export function normalizeRule(raw, fallbackId = "") {
    const goals = normalizeTargetList(raw.targetFitnessGoals || raw.targetFitnessGoal || raw.target_fitness_goals || raw.target_fitness_goal);
    const muscles = normalizeTargetList(raw.targetMuscleGroups || raw.targetMuscleGroup || raw.target_muscle_groups || raw.target_muscle_group);
    const priorityText = String(raw.priorityLabel || raw.priority || "").toLowerCase();
    const priorityLevel = priorityText === "high"
        ? 3
        : priorityText === "low"
            ? 1
            : Number(raw.priorityLevel ?? raw.priority_level ?? 1);
    const equipment = normalizeEquipmentList(raw.targetEquipment || raw.target_equipment);
    return {
        id: raw.id || raw.ruleId || fallbackId,
        ruleId: raw.ruleId || raw.id || fallbackId,
        title: raw.title || "Adaptive Rule",
        description: raw.description || "",
        targetFitnessGoal: goals[0] || "Any",
        targetFitnessGoals: goals,
        targetMuscleGroup: muscles[0] || "Any",
        targetMuscleGroups: muscles,
        targetFitnessLevel: raw.targetFitnessLevel || raw.target_fitness_level || "Any",
        targetEquipment: equipment.length ? equipment : ["Any"],
        minFrequency: Number(raw.minFrequency ?? raw.min_frequency ?? 0) || 0,
        maxFrequency: Number(raw.maxFrequency ?? raw.max_frequency ?? 0) || 0,
        progressionModifier: Number(raw.progressionModifier ?? raw.progression_modifier ?? 0),
        intensityModifier: Number(raw.intensityModifier ?? raw.intensity_modifier ?? 0),
        recoveryModifier: Number(raw.recoveryModifier ?? raw.recovery_modifier ?? 0),
        fatigueModifier: Number(raw.fatigueModifier ?? raw.fatigue_modifier ?? 0),
        optionalExerciseAdditions: normalizeArray(raw.optionalExerciseAdditions || raw.optional_exercise_additions),
        optionalExerciseRemovals: normalizeArray(raw.optionalExerciseRemovals || raw.optional_exercise_removals),
        setModifier: Number(raw.setModifier ?? raw.set_modifier ?? 0),
        repModifier: Number(raw.repModifier ?? raw.rep_modifier ?? 0),
        priorityLevel,
        priorityLabel: priorityLevel >= 3 ? "High" : "Low",
        active: raw.active !== false,
        createdAt: raw.createdAt || raw.created_at || null,
        updatedAt: raw.updatedAt || raw.updated_at || null
    };
}

export async function fetchActiveRules({ force = false } = {}) {
    if (!force && Date.now() - ruleCache.createdAt < RULE_CACHE_TTL_MS) return ruleCache.rules;
    const snap = await getDocs(query(collection(db, "ai_rules"), where("active", "==", true)));
    const rules = snap.docs
        .map((docSnap) => normalizeRule({ id: docSnap.id, ...docSnap.data() }, docSnap.id))
        .sort((a, b) => b.priorityLevel - a.priorityLevel);
    ruleCache = { createdAt: Date.now(), rules };
    return rules;
}

function ruleMatches(rule, userProfile, muscles) {
    const goals = normalizeArray(userProfile?.goals);
    const level = String(userProfile?.fitnessLevel || "").toLowerCase();
    const userEquipment = normalizeEquipmentList(userProfile?.equipment);
    const frequency = Number.parseInt(userProfile?.frequency || userProfile?.workoutFrequency, 10) || 0;
    const ruleGoals = normalizeTargetList(rule.targetFitnessGoals || rule.targetFitnessGoal);
    const ruleMuscles = normalizeTargetList(rule.targetMuscleGroups || rule.targetMuscleGroup);
    const ruleEquipment = normalizeTargetList(rule.targetEquipment);
    const goalMatch = ruleGoals.includes("Any") || goals.some((goal) => ruleGoals.includes(goal));
    const muscleMatch = ruleMuscles.includes("Any") || muscles.some((muscle) => ruleMuscles.includes(muscle));
    const levelMatch = rule.targetFitnessLevel === "Any" || level === String(rule.targetFitnessLevel).toLowerCase();
    const equipmentMatch = ruleEquipment.includes("Any") || ruleEquipment.some((item) => userEquipment.includes(item));
    const minMatch = !rule.minFrequency || frequency >= rule.minFrequency;
    const maxMatch = !rule.maxFrequency || frequency <= rule.maxFrequency;
    return goalMatch && muscleMatch && levelMatch && equipmentMatch && minMatch && maxMatch;
}

function calculateStreak(logs) {
    const days = [...new Set(logs.map((log) => getDateKey(log.created_at)).filter(Boolean))]
        .sort((a, b) => new Date(b) - new Date(a));
    if (!days.length) return 0;
    const latest = new Date(days[0]);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (Math.floor((today - latest) / (1000 * 60 * 60 * 24)) > 1) return 0;
    let streak = 1;
    for (let i = 0; i < days.length - 1; i++) {
        const gap = Math.floor((new Date(days[i]) - new Date(days[i + 1])) / (1000 * 60 * 60 * 24));
        if (gap !== 1) break;
        streak += 1;
    }
    return streak;
}

export async function getAdaptiveSignals(userId, userProfile = {}) {
    const [workoutSnap, surveySnap, progressionSnap, adjustmentSnap] = await Promise.allSettled([
        getDocs(query(collection(db, "workout_logs"), where("user_id", "==", userId), orderBy("created_at", "desc"), limit(28))),
        getDocs(query(collection(db, "survey_responses"), where("user_id", "==", userId), orderBy("created_at", "desc"), limit(16))),
        getDocs(query(collection(db, "progression_logs"), where("user_id", "==", userId), orderBy("created_at", "desc"), limit(24))),
        getDocs(query(collection(db, "workout_adjustments"), where("user_id", "==", userId), orderBy("created_at", "desc"), limit(12)))
    ]);

    const workouts = workoutSnap.status === "fulfilled" ? workoutSnap.value.docs.map((d) => d.data()) : [];
    const surveys = surveySnap.status === "fulfilled" ? surveySnap.value.docs.map((d) => d.data()) : [];
    const progression = progressionSnap.status === "fulfilled" ? progressionSnap.value.docs.map((d) => d.data()) : [];
    const adjustments = adjustmentSnap.status === "fulfilled" ? adjustmentSnap.value.docs.map((d) => d.data()) : [];

    const uniqueDays = [...new Set(workouts.map((log) => getDateKey(log.created_at)).filter(Boolean))];
    const startDate = toDateSafe(userProfile.startDate) || toDateSafe(workouts[workouts.length - 1]?.created_at) || new Date();
    const elapsedDays = Math.max(1, Math.floor((new Date() - startDate) / (1000 * 60 * 60 * 24)) + 1);
    const consistencyRate = uniqueDays.length / elapsedDays;
    const easyCount = progression.filter((log) => log.response === "easy").length;
    const hardCount = progression.filter((log) => log.response === "hard").length;
    const fatigueScore = progression.length ? hardCount / progression.length : 0;
    const progressionScore = progression.length ? (easyCount - hardCount) / progression.length : 0;
    const recentResponses = progression.map((log) => log.response);
    const recentEasyStreak = recentResponses.findIndex((response) => response !== "easy");
    const recentHardStreak = recentResponses.findIndex((response) => response !== "hard");
    const avgDuration = workouts.length
        ? workouts.reduce((acc, log) => acc + (Number(log.duration_seconds) || 0), 0) / workouts.length
        : 0;

    return {
        workouts,
        surveys,
        progression,
        adjustments,
        streak: calculateStreak(workouts),
        completedCount: workouts.length,
        missedSessions: Math.max(0, elapsedDays - uniqueDays.length),
        consistencyRate,
        fatigueScore,
        progressionScore,
        recentEasyStreak: recentEasyStreak === -1 ? recentResponses.length : recentEasyStreak,
        recentHardStreak: recentHardStreak === -1 ? recentResponses.length : recentHardStreak,
        avgDuration,
        recentMuscles: workouts.slice(0, 5).map((log) => log.muscle_group).filter(Boolean)
    };
}

function getSignalModifier(signals) {
    let setDelta = 0;
    let repDelta = 0;
    let exerciseDelta = 0;
    let intensity = 0;

    if (signals.streak >= 5 && signals.fatigueScore < 0.35) {
        repDelta += 4;
        intensity += 4;
    }
    if (signals.consistencyRate < 0.45) {
        setDelta -= 1;
        intensity -= 5;
    }
    if (signals.progressionScore > 0.35) {
        repDelta += 4;
        exerciseDelta += 1;
    }
    if ((signals.recentEasyStreak || 0) >= 3) {
        repDelta += 5;
        exerciseDelta += 1;
        intensity += 8;
    }
    if ((signals.recentHardStreak || 0) >= 3) {
        setDelta -= 1;
        repDelta -= 6;
        intensity -= 10;
    }
    if (signals.fatigueScore > 0.4) {
        setDelta -= 1;
        repDelta -= 5;
        intensity -= 8;
    }
    return { setDelta, repDelta, exerciseDelta, intensity };
}

function parseRuleIntent(rule) {
    const text = String(`${rule.title || ""} ${rule.description || ""}`).toLowerCase();
    const intent = { setDelta: 0, repDelta: 0, intensity: 0, recovery: 0 };
    if (text.includes("deload") || text.includes("recover") || text.includes("recovery")) {
        intent.setDelta -= 1;
        intent.intensity -= 8;
        intent.recovery += 10;
    }
    if (text.includes("strength") || text.includes("heavy")) {
        intent.repDelta -= 6;
        intent.intensity += 8;
    }
    if (text.includes("hypertrophy") || text.includes("muscle") || text.includes("volume")) {
        intent.repDelta += 4;
        intent.intensity += 4;
    }
    if (text.includes("fat loss") || text.includes("endurance") || text.includes("conditioning")) {
        intent.repDelta += 6;
        intent.recovery -= 3;
    }
    return intent;
}

function mergeRules(matchingRules, signals) {
    const base = getSignalModifier(signals);
    const merged = {
        setDelta: base.setDelta,
        repDelta: base.repDelta,
        exerciseDelta: base.exerciseDelta,
        intensity: base.intensity,
        recovery: signals.fatigueScore > 0.4 ? 8 : 0,
        additions: [],
        removals: [],
        triggeredRules: []
    };

    const highPriorityRules = matchingRules.filter((rule) => rule.priorityLevel >= 3);
    const rulesToApply = highPriorityRules.length ? highPriorityRules : matchingRules;

    rulesToApply.forEach((rule) => {
        const intent = parseRuleIntent(rule);
        merged.triggeredRules.push(rule);
        merged.setDelta += clamp(rule.setModifier + intent.setDelta, -1, 1);
        merged.repDelta += clamp(rule.repModifier + rule.progressionModifier + intent.repDelta, -12, 12);
        merged.intensity += clamp(rule.intensityModifier + intent.intensity, -15, 15);
        merged.recovery += clamp(rule.recoveryModifier + rule.fatigueModifier + intent.recovery, -15, 15);
        merged.additions.push(...rule.optionalExerciseAdditions);
        merged.removals.push(...rule.optionalExerciseRemovals);
    });

    merged.setDelta = clamp(merged.setDelta, -1, 1);
    merged.repDelta = clamp(merged.repDelta, -18, 18);
    merged.exerciseDelta = clamp(merged.exerciseDelta + Math.sign(merged.intensity), -1, 1);
    merged.additions = [...new Set(merged.additions.map((item) => String(item).trim()).filter(Boolean))];
    merged.removals = [...new Set(merged.removals.map((item) => String(item).trim()).filter(Boolean))];
    merged.additions = merged.additions.filter((name) => !merged.removals.some((remove) => remove.toLowerCase() === name.toLowerCase()));
    return merged;
}

function chooseExercises(pool, count, previousNames, removals) {
    const removalSet = new Set(removals.map((name) => name.toLowerCase()));
    const fresh = shuffle(pool).filter((ex) => !previousNames.has(ex.name.toLowerCase()) && !removalSet.has(ex.name.toLowerCase()));
    const fallback = shuffle(pool).filter((ex) => !removalSet.has(ex.name.toLowerCase()));
    return (fresh.length ? fresh : fallback).slice(0, count);
}

async function logAppliedRules({ userId, dayNumber, rules, modifier, muscles }) {
    if (!rules.length) return;
    await addDoc(collection(db, "ai_rule_logs"), {
        user_id: userId,
        day_number: dayNumber,
        triggered_rule_ids: rules.map((rule) => rule.id),
        triggered_rule_titles: rules.map((rule) => rule.title),
        affected_muscles: muscles,
        progression_modification: modifier.repDelta,
        set_modification: modifier.setDelta,
        exercise_delta: modifier.exerciseDelta,
        applied_difficulty_change: modifier.intensity,
        generated_changes: {
            additions: modifier.additions,
            removals: modifier.removals,
            recovery_modifier: modifier.recovery
        },
        created_at: serverTimestamp()
    });
}

async function fetchLatestUserProfile(userId, fallbackProfile = {}) {
    const userSnap = await getDoc(doc(db, "users", userId));
    const latest = userSnap.exists() ? userSnap.data() : {};
    const merged = { ...fallbackProfile, ...latest };
    const frequency = Number.parseInt(merged.frequency || merged.workoutFrequency, 10);
    const safeFrequency = Number.isFinite(frequency) ? String(clamp(frequency, 1, 7)) : "3";
    return {
        ...merged,
        workoutFrequency: safeFrequency,
        frequency: safeFrequency,
        equipment: normalizeEquipmentList(merged.equipment),
        focusAreas: normalizeArray(merged.focusAreas),
        goals: normalizeArray(merged.goals)
    };
}

function ensureValidDayExercises(day, available, previousNames) {
    const availableByName = new Map(available.map((ex) => [ex.name.toLowerCase(), ex]));
    const fallbackPool = shuffle(available);
    const repaired = [];
    (day.exercises || []).forEach((exercise) => {
        const valid = availableByName.get(String(exercise?.name || "").toLowerCase());
        const replacement = valid || fallbackPool.find((candidate) =>
            candidate.muscle_group === exercise?.muscle_group &&
            !previousNames.has(candidate.name.toLowerCase()) &&
            !repaired.some((item) => item.name.toLowerCase() === candidate.name.toLowerCase())
        ) || fallbackPool.find((candidate) =>
            !previousNames.has(candidate.name.toLowerCase()) &&
            !repaired.some((item) => item.name.toLowerCase() === candidate.name.toLowerCase())
        );
        if (!replacement) {
            console.warn("DENIO AI skipped invalid exercise without replacement:", exercise);
            return;
        }
        repaired.push({
            ...exercise,
            exercise_id: replacement.id,
            id: replacement.id,
            name: replacement.name,
            muscle_group: replacement.muscle_group,
            equipment: replacement.equipment,
            gif_url: replacement.gif_url,
            description: replacement.description,
            form_tips: replacement.form_tips
        });
        previousNames.add(replacement.name.toLowerCase());
    });
    return { ...day, exercises: repaired };
}

export async function generateAdaptiveWorkoutPlan(userId, userProfile, options = {}) {
    const exercisesSnap = await getDocs(collection(db, "exercises"));
    const allExercises = exercisesSnap.docs
        .map((docSnap) => normalizeExercise({ id: docSnap.id, ...docSnap.data() }, docSnap.id))
        .filter(isValidLibraryExercise);
    if (!allExercises.length) throw new Error("No valid exercises found in Firestore exercise library.");
    const rules = await fetchActiveRules({ force: options.forceRules === true });
    const signals = await getAdaptiveSignals(userId, userProfile);
    const level = LEVEL_SCALING[getLevelKey(userProfile)];
    const split = options.split || getWeeklySplit(userProfile);
    const basePrescription = getBasePrescription(userProfile);
    const equipment = normalizeEquipmentList(userProfile?.equipment);
    const previousNames = new Set(signals.workouts.flatMap((log) => normalizeArray(log.exercises).map((ex) => String(ex.name || "").toLowerCase())));
    const startDayNumber = Number(options.startDayNumber || 1);

    let available = allExercises;
    if (equipment.length && !equipment.includes("FULL GYM")) {
        available = allExercises.filter((ex) => {
            const exEquipment = normalizeEquipmentList(ex.equipment);
            return exEquipment.includes("NONE") || exEquipment.some((item) => equipment.includes(item));
        });
    }
    if (!available.length) {
        console.warn("DENIO AI found no equipment-compatible exercises; falling back to bodyweight library only.", { userId, equipment });
        available = allExercises.filter((ex) => normalizeEquipmentList(ex.equipment).includes("NONE"));
    }
    if (!available.length) throw new Error("No equipment-compatible exercises found in the official library.");

    const byMuscle = Object.fromEntries(MUSCLES.map((muscle) => [muscle, available.filter((ex) => ex.muscle_group === muscle)]));
    const routine = [];
    const ruleLogPromises = [];

    split.forEach((muscles, index) => {
        const matchingRules = rules.filter((rule) => ruleMatches(rule, userProfile, muscles));
        const modifier = mergeRules(matchingRules, signals);
        const dailyExercises = [];

        muscles.forEach((muscle) => {
            const isFocus = normalizeArray(userProfile?.focusAreas).includes(muscle);
            const baseCount = isFocus ? 4 : 2;
            const exerciseCount = clamp(baseCount + modifier.exerciseDelta, 1, level.maxExercises);
            let selected = chooseExercises(byMuscle[muscle] || [], exerciseCount, previousNames, modifier.removals);
            if (!selected.length) {
                const fallbackPool = byMuscle["Full Body"]?.length ? byMuscle["Full Body"] : available;
                selected = chooseExercises(fallbackPool, exerciseCount, previousNames, modifier.removals);
            }

            selected.forEach((ex) => {
                dailyExercises.push({
                    exercise_id: ex.id,
                    id: ex.id,
                    name: ex.name,
                    muscle_group: ex.muscle_group,
                    equipment: ex.equipment,
                    gif_url: ex.gif_url,
                    description: ex.description,
                    form_tips: ex.form_tips,
                    sets: clamp(basePrescription.sets + modifier.setDelta, 2, getLevelKey(userProfile) === "advanced" ? 6 : 5),
                    reps: adjustRepRange(basePrescription.reps, Math.round(modifier.repDelta * level.progression)),
                    intensity_modifier: Math.round((modifier.intensity || 0) + ((level.intensity - 1) * 10)),
                    recovery_modifier: modifier.recovery,
                    is_focus: isFocus
                });
                previousNames.add(ex.name.toLowerCase());
            });
        });

        modifier.additions.forEach((name) => {
            const extra = available.find((ex) => ex.name.toLowerCase() === name.toLowerCase());
            if (extra && !dailyExercises.some((ex) => ex.name.toLowerCase() === extra.name.toLowerCase())) {
                dailyExercises.push({
                    exercise_id: extra.id,
                    id: extra.id,
                    name: extra.name,
                    muscle_group: extra.muscle_group,
                    equipment: extra.equipment,
                    gif_url: extra.gif_url,
                    description: extra.description,
                    form_tips: extra.form_tips,
                    sets: clamp(basePrescription.sets, 2, 5),
                    reps: adjustRepRange(basePrescription.reps, Math.max(0, modifier.repDelta)),
                    intensity_modifier: modifier.intensity,
                    recovery_modifier: modifier.recovery,
                    is_focus: false,
                    rule_added: true
                });
            }
        });

        const dayNumber = startDayNumber + index;
        const day = {
            day_number: dayNumber,
            focus_label: muscles.join(" & ") + " Day",
            exercises: dailyExercises.slice(0, 10),
            adaptive_meta: {
                cycle_index: Math.floor((dayNumber - 1) / 7),
                triggered_rule_ids: matchingRules.map((rule) => rule.id),
                intensity_modifier: modifier.intensity,
                recovery_modifier: modifier.recovery
            }
        };
        routine.push(ensureValidDayExercises(day, available, previousNames));

        ruleLogPromises.push(logAppliedRules({ userId, dayNumber, rules: matchingRules, modifier, muscles }));
    });

    await Promise.allSettled(ruleLogPromises);
    return {
        user_id: userId,
        created_at: options.createdAt || new Date().toISOString(),
        updated_at: new Date().toISOString(),
        status: "Active",
        frequency: split.length,
        adaptive_version: 2,
        routine
    };
}

export async function regenerateFutureWorkoutPlan(userId, userProfile, options = {}) {
    const currentDayNumber = Math.max(1, Number(options.currentDayNumber || 1));
    const latestProfile = await fetchLatestUserProfile(userId, userProfile);
    console.debug("DENIO regeneration using latest profile snapshot:", {
        userId,
        frequency: latestProfile.frequency,
        equipment: latestProfile.equipment,
        focusAreas: latestProfile.focusAreas,
        goals: latestProfile.goals,
        fetchedAt: new Date().toISOString()
    });
    const planRef = doc(db, "workout_plans", userId);
    const planSnap = await getDoc(planRef);
    const existingPlan = planSnap.exists() ? planSnap.data() : {};
    const existingRoutine = Array.isArray(existingPlan.routine) ? existingPlan.routine : [];
    const preservedRoutine = existingRoutine.filter((day) => Number(day.day_number) <= currentDayNumber);
    const targetLength = Math.max(existingRoutine.length, currentDayNumber + 7);
    let nextRoutine = [...preservedRoutine];

    while (nextRoutine.length < targetLength) {
        const generated = await generateAdaptiveWorkoutPlan(userId, latestProfile, {
            startDayNumber: nextRoutine.length + 1,
            createdAt: existingPlan.created_at || latestProfile.startDate || new Date().toISOString(),
            forceRules: true
        });
        nextRoutine = nextRoutine.concat(generated.routine);
    }

    const updatedPlan = {
        ...existingPlan,
        user_id: userId,
        created_at: existingPlan.created_at || latestProfile.startDate || new Date().toISOString(),
        updated_at: new Date().toISOString(),
        status: "Active",
        frequency: Number.parseInt(latestProfile?.frequency || latestProfile?.workoutFrequency, 10) || existingPlan.frequency || 3,
        adaptive_version: 2,
        routine: nextRoutine
    };

    await setDoc(planRef, updatedPlan, { merge: false });
    return updatedPlan;
}

export async function saveAdaptiveWorkoutPlan(userId, userProfile, options = {}) {
    const planData = await generateAdaptiveWorkoutPlan(userId, userProfile, { forceRules: true, ...options });
    await setDoc(doc(db, "workout_plans", userId), planData, { merge: false });
    return planData;
}

export async function extendWorkoutPlanIfNeeded(userId, userProfile, targetDayNumber) {
    const planRef = doc(db, "workout_plans", userId);
    const planSnap = await getDoc(planRef);
    if (!planSnap.exists()) return null;
    const plan = planSnap.data();
    const routine = Array.isArray(plan.routine) ? plan.routine : [];
    if (routine.length >= targetDayNumber) return plan;

    let nextRoutine = [...routine];
    while (nextRoutine.length < targetDayNumber) {
        const generated = await generateAdaptiveWorkoutPlan(userId, userProfile, {
            startDayNumber: nextRoutine.length + 1,
            createdAt: plan.created_at || new Date().toISOString(),
            forceRules: true
        });
        nextRoutine = nextRoutine.concat(generated.routine);
    }

    const updatedPlan = {
        ...plan,
        routine: nextRoutine,
        updated_at: new Date().toISOString(),
        adaptive_version: 2
    };
    await updateDoc(planRef, {
        routine: nextRoutine,
        updated_at: updatedPlan.updated_at,
        adaptive_version: 2
    });
    return updatedPlan;
}

export function buildPredictiveInsights({ workoutLogs = [], progressionLogs = [], adjustments = [], userData = {} }) {
    const uniqueDays = [...new Set(workoutLogs.map((log) => getDateKey(log.created_at)).filter(Boolean))];
    const streak = calculateStreak(workoutLogs);
    const hardRate = progressionLogs.length ? progressionLogs.filter((log) => log.response === "hard").length / progressionLogs.length : 0;
    const easyRate = progressionLogs.length ? progressionLogs.filter((log) => log.response === "easy").length / progressionLogs.length : 0;
    const avgDuration = workoutLogs.length
        ? workoutLogs.reduce((acc, log) => acc + (Number(log.duration_seconds) || 0), 0) / workoutLogs.length
        : 0;
    const maxWeightTrend = workoutLogs.slice(0, 6).reduce((acc, log) => acc + (Number(log.max_weight) || 0), 0);
    const olderTrend = workoutLogs.slice(6, 12).reduce((acc, log) => acc + (Number(log.max_weight) || 0), 0);
    const plateau = workoutLogs.length >= 8 && Math.abs(maxWeightTrend - olderTrend) < 5 && easyRate < 0.25;
    const focusAreas = normalizeArray(userData.focusAreas);
    const trained = workoutLogs.slice(0, 8).map((log) => String(log.muscle_group || ""));
    const recommendedFocus = focusAreas.find((focus) => !trained.some((muscle) => muscle.includes(focus))) || focusAreas[0] || "Full Body";

    return {
        streak,
        consistencyScore: Math.round((uniqueDays.length / Math.max(1, workoutLogs.length || uniqueDays.length)) * 100),
        fatigueLabel: hardRate > 0.4 ? "Elevated fatigue: deload pressure is building." : "Recovery looks manageable from recent feedback.",
        progressionForecast: easyRate > 0.35 ? "Progression forecast is positive; gradual overload is appropriate." : "Progression forecast is steady; keep pacing controlled.",
        plateauWarning: plateau ? "Plateau warning: recent max-weight trend has flattened. Exercise variation or a new progression block may help." : "No strong plateau signal detected yet.",
        recoveryInsight: avgDuration > 3600 && hardRate > 0.3 ? "Long sessions plus hard feedback suggest recovery spacing should improve." : "Session length and recovery stress are within a sustainable range.",
        adaptationSpeed: streak >= 5 && hardRate < 0.3 ? "Adaptation speed is above baseline because consistency is strong." : "Adaptation speed is moderate; consistency will decide the next jump.",
        recommendedFocus
    };
}

export function buildCoachJayMessage({ context = "home", signals = {}, userData = {}, muscleGroup = "" }) {
    const storageKey = `denio_coach_jay_${context}`;
    let memory = { index: -1, last: "", used: [] };
    try {
        memory = { ...memory, ...JSON.parse(localStorage.getItem(storageKey) || "{}") };
    } catch {
        memory = { index: -1, last: "", used: [] };
    }

    let category = "dailyMotivation";
    if (context === "home") {
        const rotation = ["dailyMotivation", "intenseDiscipline", "reminder"];
        memory.index = (Number(memory.index) + 1) % rotation.length;
        category = rotation[memory.index];
    } else if (context === "session") {
        const rotation = ["intenseDiscipline", "workoutTips", "exerciseSpecificTips"];
        memory.index = (Number(memory.index) + 1) % rotation.length;
        category = rotation[memory.index];
    } else if (context === "exercise") {
        const rotation = ["exerciseSpecificTips", "intenseDiscipline", "workoutTips"];
        memory.index = (Number(memory.index) + 1) % rotation.length;
        category = rotation[memory.index];
    } else if (context === "result") {
        category = Math.random() > 0.35 ? "congratulatory" : "dailyMotivation";
    }

    let source = COACH_JAY_MESSAGE_POOLS[category] || COACH_JAY_MESSAGE_POOLS.dailyMotivation;
    if (category === "reminder") {
        const missed = Number(signals.missedSessions) || 0;
        const streak = Number(signals.streak) || 0;
        source = missed > 0
            ? [
                `You have ${missed} missed workout${missed === 1 ? "" : "s"} to answer for. Make the comeback simple today.`,
                "A skipped day does not own the week. Get one clean session back on the board.",
                "The plan is waiting for one honest restart. Keep it manageable and finish."
            ]
            : [
                `Current streak: ${streak}. Protect it with clean, controlled work today.`,
                "Your consistency is doing its job. Keep the rhythm steady.",
                "You have momentum. Do not make today complicated."
            ];
    }

    const recent = new Set([memory.last, ...(memory.used || []).slice(-8)]);
    const candidates = source.filter((line) => !recent.has(line));
    const pool = candidates.length ? candidates : source.filter((line) => line !== memory.last);
    const line = (pool.length ? pool : source)[Math.floor(Math.random() * (pool.length ? pool.length : source.length))];
    memory.last = line;
    memory.used = [...(memory.used || []), line].slice(-16);
    try {
        localStorage.setItem(storageKey, JSON.stringify(memory));
    } catch {}
    const name = userData.name ? `${userData.name}, ` : "";
    const scoped = muscleGroup && context === "exercise" ? `${muscleGroup}: ${line}` : line;
    return context === "summary" ? `Coach Jay: ${scoped}` : `${name}${scoped}`;
}
