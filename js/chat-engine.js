import { db } from "./firebase.js";
import {
    addDoc,
    collection,
    getDocs,
    limit,
    orderBy,
    query,
    serverTimestamp,
    where
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

const LOCAL_HISTORY_LIMIT = 20;
const PROMPT_CONTEXT_LIMIT = 8;
const REQUEST_TIMEOUT_MS = 18000;
const MAX_RETRIES = 2;

const SUGGESTED_PROMPTS = [
    "What should I train today based on my recent workouts?",
    "How do I recover from soreness without losing progress?",
    "What should I eat today for muscle growth?",
    "How can I improve my weak muscle groups?",
    "Is this soreness normal or should I rest?"
];

const DENIO_SYSTEM_PROMPT = `
You are DENIO, the AI chatbot inside a fitness app.
Personality: motivational, supportive, fitness-focused, knowledgeable, slightly strict but encouraging.
Style: natural conversation, concise paragraphs, practical steps, no markdown tables unless necessary.
Safety rules:
- Do not give medical diagnosis, injury treatment, eating disorder advice, steroid/drug guidance, dehydration/cutting tactics, or extreme dieting plans.
- For chest pain, fainting, severe injury, sharp joint pain, neurological symptoms, or dangerous weight-loss intent, tell the user to stop training and consult a qualified medical professional.
- Encourage progressive overload, good form, recovery, hydration, sleep, and sustainable nutrition.
- Keep recommendations appropriate to the user's goal, fitness level, recent workouts, and fatigue signals.
`;

function getStorageKey(userId) {
    return `denio_chat_history_${userId}`;
}

function nowIso() {
    return new Date().toISOString();
}

function toDateSafe(value) {
    if (!value) return null;
    if (typeof value.toDate === "function") return value.toDate();
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getTextConfig(name, fallback = "") {
    const config = window.DENIO_AI_CONFIG || {};
    const meta = document.querySelector(`meta[name="${name}"]`);
    return config[name] || localStorage.getItem(name) || meta?.content || fallback;
}

function getAiConfig() {
    return {
        geminiKey: getTextConfig("DENIO_GEMINI_API_KEY"),
        grokKey: getTextConfig("DENIO_GROK_API_KEY"),
        geminiModel: getTextConfig("DENIO_GEMINI_MODEL", "gemini-2.0-flash"),
        grokModel: getTextConfig("DENIO_GROK_MODEL", "grok-4")
    };
}

function normalizeArray(value) {
    if (Array.isArray(value)) return value.filter(Boolean);
    if (!value) return [];
    return [value];
}

function calculateCurrentStreak(logs) {
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

function extractMuscleGroupsFromLogs(logs) {
    return logs
        .slice(0, 5)
        .map((log) => log.muscle_group || log.workout_label)
        .filter(Boolean);
}

function getLocalSessionSnapshot() {
    const activeRaw = localStorage.getItem("denio_active_session");
    const lastRaw = localStorage.getItem("denio_last_session_stats");
    const snapshots = [];

    try {
        const active = activeRaw ? JSON.parse(activeRaw) : null;
        if (active?.meta) snapshots.push({ type: "active_session", ...active.meta });
    } catch (error) {
        console.warn("DENIO chat could not parse active session:", error);
    }

    try {
        const last = lastRaw ? JSON.parse(lastRaw) : null;
        if (last) snapshots.push({ type: "last_completed_session", ...last });
    } catch (error) {
        console.warn("DENIO chat could not parse last session:", error);
    }

    return snapshots;
}

function loadLocalMessages(userId) {
    try {
        const parsed = JSON.parse(localStorage.getItem(getStorageKey(userId)) || "[]");
        return Array.isArray(parsed) ? parsed.slice(-LOCAL_HISTORY_LIMIT) : [];
    } catch (error) {
        console.warn("DENIO chat history reset after parse error:", error);
        return [];
    }
}

function saveLocalMessages(userId, messages) {
    localStorage.setItem(getStorageKey(userId), JSON.stringify(messages.slice(-LOCAL_HISTORY_LIMIT)));
}

async function saveMessageToFirestore(userId, message) {
    try {
        await addDoc(collection(db, "users", userId, "chat_messages"), {
            role: message.role,
            text: message.text,
            provider: message.provider || null,
            created_at_iso: message.createdAt,
            created_at: serverTimestamp()
        });
    } catch (error) {
        console.warn("DENIO chat Firestore save skipped:", error);
    }
}

function sortByCreatedAtDesc(items) {
    return [...items].sort((a, b) => {
        const bDate = toDateSafe(b.created_at)?.getTime() || 0;
        const aDate = toDateSafe(a.created_at)?.getTime() || 0;
        return bDate - aDate;
    });
}

async function loadFirestoreMessages(userId) {
    try {
        const snap = await getDocs(query(
            collection(db, "users", userId, "chat_messages"),
            orderBy("created_at", "desc"),
            limit(LOCAL_HISTORY_LIMIT)
        ));
        return snap.docs
            .map((docSnap) => {
                const data = docSnap.data();
                return {
                    role: data.role,
                    text: data.text,
                    provider: data.provider || null,
                    createdAt: data.created_at_iso || toDateSafe(data.created_at)?.toISOString() || nowIso()
                };
            })
            .reverse();
    } catch (error) {
        console.warn("DENIO chat Firestore history unavailable:", error);
        return [];
    }
}

async function fetchRecentUserDocs(collectionName, userId, maxItems) {
    try {
        const snap = await getDocs(query(
            collection(db, collectionName),
            where("user_id", "==", userId),
            orderBy("created_at", "desc"),
            limit(maxItems)
        ));
        return snap.docs.map((docSnap) => docSnap.data());
    } catch (error) {
        console.warn(`DENIO chat falling back to unindexed ${collectionName} read:`, error);
        try {
            const fallbackSnap = await getDocs(query(collection(db, collectionName), where("user_id", "==", userId)));
            return sortByCreatedAtDesc(fallbackSnap.docs.map((docSnap) => docSnap.data())).slice(0, maxItems);
        } catch (fallbackError) {
            console.warn(`DENIO chat could not load ${collectionName}:`, fallbackError);
            return [];
        }
    }
}

async function fetchActivePlan(userId) {
    try {
        const snap = await getDocs(query(collection(db, "workout_plans"), where("user_id", "==", userId), limit(1)));
        return snap.docs[0]?.data() || null;
    } catch (error) {
        console.warn("DENIO chat could not load active workout plan:", error);
        return null;
    }
}

async function fetchUserContext(user, userData) {
    const [workoutLogs, surveyResponses, progressionLogs, plan] = await Promise.all([
        fetchRecentUserDocs("workout_logs", user.uid, 8),
        fetchRecentUserDocs("survey_responses", user.uid, 5),
        fetchRecentUserDocs("progression_logs", user.uid, 8),
        fetchActivePlan(user.uid)
    ]);

    return {
        profile: {
            name: userData?.name || "User",
            goals: normalizeArray(userData?.goals),
            fitnessLevel: userData?.fitnessLevel || userData?.level || "Unknown",
            workoutFrequency: userData?.workoutFrequency || userData?.frequency || "Unknown",
            equipment: normalizeArray(userData?.equipment),
            focusAreas: normalizeArray(userData?.focusAreas),
            latestSurveyResponse: userData?.latestSurveyResponse || null,
            pendingProgressionAdjustment: userData?.pendingProgressionAdjustment || null
        },
        recentWorkouts: workoutLogs.slice(0, 5).map((log) => ({
            workout: log.workout_label || log.workout_day || "Workout",
            muscleGroup: log.muscle_group || "General",
            duration: log.duration_label || `${Math.round((log.duration_seconds || 0) / 60)} min`,
            sets: log.total_sets || 0,
            reps: log.total_reps || 0,
            maxWeight: log.max_weight || 0,
            date: toDateSafe(log.created_at)?.toISOString() || null
        })),
        currentStreak: calculateCurrentStreak(workoutLogs),
        recentSurveyResponses: surveyResponses.map((item) => ({
            muscleGroup: item.muscle_group || "General",
            response: item.response_label || item.response,
            date: toDateSafe(item.created_at)?.toISOString() || null
        })),
        recentlyTrainedMuscleGroups: extractMuscleGroupsFromLogs(workoutLogs),
        progressionHistory: progressionLogs.map((item) => ({
            muscleGroup: item.muscle_group || "General",
            response: item.response,
            mode: item.progression_mode,
            consecutiveEasyCount: item.consecutive_easy_count || 0,
            date: toDateSafe(item.created_at)?.toISOString() || null
        })),
        activePlan: plan?.routine?.slice(0, 7).map((day) => ({
            day: day.day_number,
            focus: day.focus_label,
            exercises: (day.exercises || []).slice(0, 8).map((ex) => `${ex.name} (${ex.sets}x${ex.reps})`)
        })) || [],
        localSessions: getLocalSessionSnapshot()
    };
}

function buildPrompt({ messages, userMessage, context }) {
    const recentConversation = messages
        .slice(-PROMPT_CONTEXT_LIMIT)
        .map((message) => `${message.role === "user" ? "User" : "DENIO"}: ${message.text}`)
        .join("\n");

    return [
        DENIO_SYSTEM_PROMPT.trim(),
        "User context JSON:",
        JSON.stringify(context, null, 2),
        "Recent conversation:",
        recentConversation || "No prior conversation yet.",
        `Current user message: ${userMessage}`,
        "Reply as DENIO. Be useful, safe, and conversational."
    ].join("\n\n");
}

function isRetryableStatus(status) {
    return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, options, timeoutMs = REQUEST_TIMEOUT_MS) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timeoutId);
    }
}

async function withRetries(requestFn) {
    let lastError = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            return await requestFn();
        } catch (error) {
            lastError = error;
            const retryable = error.retryable || error.name === "AbortError";
            if (!retryable || attempt === MAX_RETRIES) break;
            await delay(500 * (attempt + 1));
        }
    }
    throw lastError;
}

function makeHttpError(provider, response, bodyText) {
    const error = new Error(`${provider} request failed (${response.status})`);
    error.status = response.status;
    error.retryable = isRetryableStatus(response.status);
    error.body = bodyText;
    return error;
}

async function callGemini(prompt, config) {
    if (!config.geminiKey) throw Object.assign(new Error("Gemini API key is not configured."), { retryable: false });
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.geminiModel)}:generateContent?key=${encodeURIComponent(config.geminiKey)}`;

    return withRetries(async () => {
        const response = await fetchWithTimeout(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                contents: [{ role: "user", parts: [{ text: prompt }] }],
                generationConfig: {
                    temperature: 0.7,
                    topP: 0.9,
                    maxOutputTokens: 700
                },
                safetySettings: [
                    { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
                    { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
                    { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
                    { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" }
                ]
            })
        });

        const bodyText = await response.text();
        if (!response.ok) throw makeHttpError("Gemini", response, bodyText);

        const data = JSON.parse(bodyText);
        const text = data.candidates?.[0]?.content?.parts?.map((part) => part.text).filter(Boolean).join("\n").trim();
        if (!text) throw Object.assign(new Error("Gemini returned an empty response."), { retryable: true });
        return { text, provider: "gemini" };
    });
}

async function callGrok(prompt, config) {
    if (!config.grokKey) throw Object.assign(new Error("Grok API key is not configured."), { retryable: false });

    return withRetries(async () => {
        const response = await fetchWithTimeout("https://api.x.ai/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${config.grokKey}`
            },
            body: JSON.stringify({
                model: config.grokModel,
                stream: false,
                temperature: 0.7,
                max_tokens: 700,
                messages: [
                    { role: "system", content: DENIO_SYSTEM_PROMPT.trim() },
                    { role: "user", content: prompt }
                ]
            })
        });

        const bodyText = await response.text();
        if (!response.ok) throw makeHttpError("Grok", response, bodyText);

        const data = JSON.parse(bodyText);
        const text = data.choices?.[0]?.message?.content?.trim();
        if (!text) throw Object.assign(new Error("Grok returned an empty response."), { retryable: true });
        return { text, provider: "grok" };
    });
}

function getSafeFallbackReply(error) {
    console.error("DENIO AI providers unavailable:", error);
    return "I could not reach the AI service right now, but here is the safe move: keep today's training controlled, avoid max attempts if you're tired or sore, hydrate, and focus on clean form. Ask me again in a moment and I'll get more specific.";
}

function createMessage(role, text, provider = null) {
    return { role, text, provider, createdAt: nowIso() };
}

function formatTime(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function createTypingBubble() {
    const bubble = document.createElement("div");
    bubble.className = "msg-bubble msg-ai denio-typing";
    bubble.id = "denioTyping";
    bubble.innerHTML = `<span></span><span></span><span></span>`;
    return bubble;
}

function renderMessage(chatArea, message) {
    const bubble = document.createElement("div");
    bubble.className = `msg-bubble msg-${message.role === "user" ? "user" : "ai"}`;
    bubble.innerText = message.text;

    const meta = document.createElement("div");
    meta.className = "msg-time";
    meta.innerText = formatTime(message.createdAt);
    bubble.appendChild(meta);

    chatArea.appendChild(bubble);
}

function renderSuggestions(chatArea, onPick) {
    const existing = document.getElementById("denioSuggestions");
    if (existing) existing.remove();

    const wrap = document.createElement("div");
    wrap.id = "denioSuggestions";
    wrap.className = "chat-suggestions";

    SUGGESTED_PROMPTS.forEach((prompt) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "chat-suggestion-btn";
        button.innerText = prompt;
        button.addEventListener("click", () => onPick(prompt));
        wrap.appendChild(button);
    });

    chatArea.appendChild(wrap);
}

function scrollToBottom(chatArea) {
    requestAnimationFrame(() => {
        chatArea.scrollTop = chatArea.scrollHeight;
    });
}

function setLoadingState(isLoading, inputField, sendButton) {
    inputField.disabled = isLoading;
    if (sendButton) {
        sendButton.disabled = isLoading;
        sendButton.classList.toggle("is-loading", isLoading);
    }
}

export async function initChatEngine({ user, userData }) {
    const chatArea = document.getElementById("chatArea");
    const inputField = document.getElementById("userInput");
    const sendButton = document.querySelector(".chat-send");
    if (!chatArea || !inputField) return;

    const config = getAiConfig();
    let messages = loadLocalMessages(user.uid);
    let isRequestInFlight = false;
    let contextCache = null;
    let contextLoadedAt = 0;

    const firestoreMessages = await loadFirestoreMessages(user.uid);
    if (firestoreMessages.length > messages.length) {
        messages = firestoreMessages;
        saveLocalMessages(user.uid, messages);
    }

    function renderAll() {
        chatArea.innerHTML = "";
        if (!messages.length) {
            const greeting = createMessage(
                "assistant",
                `I'm DENIO. Tell me what you need: training, recovery, nutrition, soreness, or progress. I will keep it useful and honest.`
            );
            renderMessage(chatArea, greeting);
        } else {
            messages.forEach((message) => renderMessage(chatArea, message));
        }
        renderSuggestions(chatArea, submitMessage);
        scrollToBottom(chatArea);
    }

    async function getContext() {
        const ageMs = Date.now() - contextLoadedAt;
        if (contextCache && ageMs < 60000) return contextCache;
        contextCache = await fetchUserContext(user, userData);
        contextLoadedAt = Date.now();
        return contextCache;
    }

    async function getAiReply(userMessage) {
        const context = await getContext();
        const prompt = buildPrompt({ messages, userMessage, context });

        try {
            return await callGemini(prompt, config);
        } catch (geminiError) {
            return callGrok(prompt, config);
        }
    }

    async function submitMessage(forcedText = "") {
        const text = String(forcedText || inputField.value).trim();
        if (!text || isRequestInFlight) return;

        isRequestInFlight = true;
        setLoadingState(true, inputField, sendButton);
        inputField.value = "";
        document.getElementById("denioSuggestions")?.remove();

        const userMessage = createMessage("user", text);
        messages.push(userMessage);
        saveLocalMessages(user.uid, messages);
        renderMessage(chatArea, userMessage);
        saveMessageToFirestore(user.uid, userMessage);

        const typingBubble = createTypingBubble();
        chatArea.appendChild(typingBubble);
        scrollToBottom(chatArea);

        let assistantMessage;
        try {
            const aiReply = await getAiReply(text);
            assistantMessage = createMessage("assistant", aiReply.text, aiReply.provider);
        } catch (error) {
            assistantMessage = createMessage("assistant", getSafeFallbackReply(error), "local-safety");
        } finally {
            typingBubble.remove();
        }

        messages.push(assistantMessage);
        saveLocalMessages(user.uid, messages);
        renderMessage(chatArea, assistantMessage);
        saveMessageToFirestore(user.uid, assistantMessage);
        renderSuggestions(chatArea, submitMessage);
        scrollToBottom(chatArea);

        isRequestInFlight = false;
        setLoadingState(false, inputField, sendButton);
        inputField.focus();
    }

    window.sendMessage = submitMessage;
    window.appendMessage = function appendMessage(text, senderType) {
        const role = senderType === "user" ? "user" : "assistant";
        const message = createMessage(role, text);
        messages.push(message);
        saveLocalMessages(user.uid, messages);
        renderMessage(chatArea, message);
        scrollToBottom(chatArea);
    };

    inputField.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submitMessage();
        }
    });

    renderAll();
}
