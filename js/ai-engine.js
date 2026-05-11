// js/ai-engine.js
import { saveAdaptiveWorkoutPlan } from "./adaptive-engine.js";

export async function generateWorkoutPlan(userId, userProfile) {
    try {
        console.log("DENIO AI: Starting adaptive generation for user:", userId);
        await saveAdaptiveWorkoutPlan(userId, userProfile, { startDayNumber: 1 });
        return true;
    } catch (error) {
        console.error("AI Engine Error:", error);
        return false;
    }
}
