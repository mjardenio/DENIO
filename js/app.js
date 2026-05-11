// js/app.js

import { auth, db } from './firebase.js';
import { doc, getDoc, serverTimestamp, updateDoc } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { initSessionEngine } from "./session-engine.js";
import { initResultEngine } from "./result-engine.js";
import { initSummaryEngine } from "./summary-engine.js";
import { initLibraryEngine } from "./library-engine.js";
import { initChatEngine } from "./chat-engine.js";
import { createAdminNotification, updateUserPresence } from "./admin-services.js";
import { buildCoachJayMessage, getAdaptiveSignals, normalizeEquipmentList } from "./adaptive-engine.js";
import { regenerateFutureWorkoutPlan } from "./adaptive-engine.js";
import { formatWorkoutDayLabel, getScheduleForDate, getWeekdayName, normalizeLiftDayNumber } from "./schedule-engine.js";

// We use onAuthStateChanged instead of DOMContentLoaded to ensure Firebase is ready
onAuthStateChanged(auth, async (user) => {
    if (user) {
        console.log("User is logged in. Fetching data from Firestore...");
        
        try {
            if (user.email !== "admin@denio.app") {
                updateUserPresence(user, {
                    isActive: true,
                    lastSeenAt: serverTimestamp(),
                    lastSeenAtIso: new Date().toISOString()
                });
            }
            // 1. Fetch user data from Firestore
            const userDocRef = doc(db, "users", user.uid);
            const userDocSnap = await getDoc(userDocRef);

            let userData = {};
            if (userDocSnap.exists()) {
                userData = userDocSnap.data();
            } else {
                console.warn("User document does not exist in Firestore.");
            }

            // --- GLOBAL: Set User Name ---
            const profileName = userData.name || 'User';
            document.querySelectorAll('.profile-chip span').forEach(el => el.innerText = profileName);
            document.querySelectorAll('.profile-img').forEach(el => el.innerText = profileName.charAt(0).toUpperCase());

            // --- SHARED DATA ---
            const todaySchedule = getScheduleForDate(userData);
            const trueCurrentAppDay = normalizeLiftDayNumber(userData.currentLiftDay || todaySchedule.workoutDayNumber || 1, 1);
            const startDate = new Date(userData.startDate || new Date().toISOString());
            const diffDays = todaySchedule.calendarDayNumber - 1;
            const currentCycle = Math.floor(diffDays / 7); // Cycle 0 = days 1-7, Cycle 1 = days 8-14
            const startDayNum = (currentCycle * 7) + 1;
            
            // Get array of completed days securely from Firestore
            let completedDays = userData.completedDays || [];


            // =========================================
            // HOMEPAGE LOGIC
            // =========================================
            if (document.getElementById('dayContainer')) {
                window.selectedDay = trueCurrentAppDay; // Default view is today

                function initDays() {
                    const dayContainer = document.getElementById('dayContainer');
                    dayContainer.innerHTML = '';
                    
                    for(let i = 0; i < 7; i++) {
                        const dayNum = startDayNum + i;
                        const btn = document.createElement('button');
                        
                        // Build class list based on state
                        let classes = 'day-btn';
                        if (dayNum === window.selectedDay) classes += ' active';
                        if (dayNum === trueCurrentAppDay) classes += ' current-day-border';
                        if (completedDays.includes(dayNum)) classes += ' completed';
                        
                        btn.className = classes;
                        btn.innerText = formatWorkoutDayLabel(dayNum);
                        btn.onclick = () => window.selectDay(dayNum);
                        dayContainer.appendChild(btn);
                    }
                    window.selectDay(window.selectedDay); // Initialize text
                }

                window.selectDay = function(day) {
                    window.selectedDay = day;
                    
                    // Re-render buttons to apply active state
                    document.querySelectorAll('.day-btn').forEach(btn => {
                        const btnDayNum = parseInt(btn.innerText.replace('Day ', ''));
                        btn.classList.remove('active');
                        if (btnDayNum === day) btn.classList.add('active');
                    });
                    
                    // Map the selected day to the real day of the week
                    const targetDate = new Date(startDate);
                    targetDate.setDate(startDate.getDate() + (day - 1));
                    const targetDayName = getWeekdayName(targetDate.toISOString().slice(0, 10));
                    
                    document.getElementById('workoutTitle').innerText = `${targetDayName} WORKOUT`;
                    
                    // Update UI based on completion status
                    const isCompleted = completedDays.includes(day);
                    const exCards = document.querySelectorAll('.ex-card');
                    const exScroll = document.getElementById('exerciseList');
                    const alertMsg = document.getElementById('alertMsg');
                    const startBtn = document.getElementById('startBtn');

                    if (isCompleted) {
                        exCards.forEach(card => card.classList.add('completed-ex'));
                        exScroll.classList.remove('locked');
                        startBtn.disabled = true;
                        startBtn.innerText = "COMPLETED";
                        if(alertMsg) alertMsg.style.display = 'none';
                    } else if (day === trueCurrentAppDay) {
                        exCards.forEach(card => card.classList.remove('completed-ex'));
                        exScroll.classList.remove('locked');
                        startBtn.disabled = false;
                        startBtn.innerText = "START WORKOUT";
                        if(alertMsg) alertMsg.style.display = 'none';
                    } else {
                        exCards.forEach(card => card.classList.remove('completed-ex'));
                        exScroll.classList.add('locked');
                        startBtn.disabled = true;
                        startBtn.innerText = "START WORKOUT";
                    }
                }

                window.startSession = function() {
                    if(!document.getElementById('startBtn').disabled) {
                        window.location.href = 'session-page.html';
                    }
                }

                document.getElementById('startContainer').addEventListener('click', function() {
                    const btn = document.getElementById('startBtn');
                    if(btn.disabled && btn.innerText !== "COMPLETED") {
                        const alertMsg = document.getElementById('alertMsg');
                        if(alertMsg) {
                            alertMsg.innerText = "Session can't start. Workout day doesn't match the current day.";
                            alertMsg.style.display = 'block';
                            setTimeout(() => { alertMsg.style.display = 'none'; }, 3000);
                        }
                    }
                });

                initDays();
            }


            // =========================================
            // PROFILE VIEW LOGIC
            // =========================================
            if (document.getElementById('pvName')) {
                // 1. Populate data from Firestore (userData) instead of localStorage
                document.getElementById('pvName').innerText = profileName;
                document.getElementById('pvAvatar').innerText = profileName.charAt(0).toUpperCase();
                document.getElementById('pvAge').innerText = userData.age || '--';
                document.getElementById('pvGender').innerText = userData.gender || '--';
                document.getElementById('pvHeight').innerText = userData.height || '--';
                document.getElementById('pvWeight').innerText = userData.weight || '--';
                document.getElementById('pvLevel').innerText = userData.fitnessLevel || '--';
                document.getElementById('pvFreq').innerText = userData.workoutFrequency || '--';

                const equipData = normalizeEquipmentList(userData.equipment || []);
                document.getElementById('pvEquip').innerText = equipData.length > 0 ? equipData.join(', ') : '--';

                const focusData = userData.focusAreas || [];
                document.getElementById('pvFocus').innerText = focusData.length > 0 ? focusData.join(', ') : '--';

                const goalData = userData.goals || [];
                document.getElementById('pvGoal').innerText = goalData.length > 0 ? goalData.join(', ') : '--';

                function setupEditGroup(groupId, currentValues, single = false) {
                    const group = document.getElementById(groupId);
                    if (!group) return;
                    const values = Array.isArray(currentValues) ? currentValues : [currentValues].filter(Boolean);
                    const normalizedValues = values.map((value) => String(value).toLowerCase());
                    group.querySelectorAll('.sel-btn').forEach((btn) => {
                        if (normalizedValues.includes(String(btn.dataset.value).toLowerCase())) btn.classList.add('selected');
                        btn.addEventListener('click', () => {
                            const value = String(btn.dataset.value).toLowerCase();
                            const isFullBody = value === 'full body';
                            const isExclusiveEquipment = groupId === 'editEquipGroup' && (value === 'full gym' || value === 'none');
                            if (single) group.querySelectorAll('.sel-btn').forEach((item) => item.classList.remove('selected'));
                            if (isExclusiveEquipment) {
                                if (btn.classList.contains('selected')) {
                                    btn.classList.remove('selected');
                                    return;
                                }
                                group.querySelectorAll('.sel-btn').forEach((item) => item.classList.remove('selected'));
                                btn.classList.add('selected');
                                return;
                            }
                            if (groupId === 'editEquipGroup') {
                                group.querySelectorAll('.sel-btn').forEach((item) => {
                                    const itemValue = String(item.dataset.value).toLowerCase();
                                    if (itemValue === 'full gym' || itemValue === 'none') item.classList.remove('selected');
                                });
                                btn.classList.toggle('selected');
                                return;
                            }
                            if (!single && isFullBody && !btn.classList.contains('selected')) {
                                group.querySelectorAll('.sel-btn').forEach((item) => item.classList.remove('selected'));
                            }
                            if (!single && !isFullBody) {
                                group.querySelectorAll('.sel-btn').forEach((item) => {
                                    if (String(item.dataset.value).toLowerCase() === 'full body') item.classList.remove('selected');
                                });
                            }
                            btn.classList.toggle('selected');
                        });
                    });
                }

                function getSelectedValues(groupId) {
                    return Array.from(document.querySelectorAll(`#${groupId} .sel-btn.selected`)).map((btn) => btn.dataset.value);
                }

                setupEditGroup('editFreqGroup', userData.workoutFrequency || userData.frequency, true);
                setupEditGroup('editEquipGroup', equipData);
                setupEditGroup('editFocusGroup', focusData);
                setupEditGroup('editGoalGroup', goalData);

                // 2. Button Listeners
                document.getElementById('pvBackBtn').addEventListener('click', () => {
                    window.location.href = 'homepage.html';
                });

                document.getElementById('openEditModalBtn').addEventListener('click', () => {
                    document.getElementById('editModal').style.display = 'flex';
                });

                document.getElementById('closeEditModalBtn').addEventListener('click', () => {
                    document.getElementById('editModal').style.display = 'none';
                });

                document.getElementById('generateNewRoutineBtn').addEventListener('click', async () => {
                    const frequency = getSelectedValues('editFreqGroup')[0];
                    const equipment = normalizeEquipmentList(getSelectedValues('editEquipGroup'));
                    const focusAreas = getSelectedValues('editFocusGroup');
                    const goals = getSelectedValues('editGoalGroup');
                    if (!frequency || !equipment.length || !focusAreas.length || !goals.length) {
                        window.showDenioAlert('Please select frequency, equipment, focus area, and goals.');
                        return;
                    }
                    const btn = document.getElementById('generateNewRoutineBtn');
                    btn.disabled = true;
                    btn.innerText = 'GENERATING...';
                    try {
                        const updatedProfile = {
                            ...userData,
                            workoutFrequency: frequency,
                            frequency,
                            equipment,
                            focusAreas,
                            goals,
                            completedDays: userData.completedDays || [],
                            startDate: userData.startDate || new Date().toISOString()
                        };
                        await updateDoc(doc(db, "users", user.uid), {
                            workoutFrequency: frequency,
                            frequency,
                            equipment,
                            focusAreas,
                            goals,
                            routineRegeneratedAtIso: new Date().toISOString()
                        });
                        await regenerateFutureWorkoutPlan(user.uid, updatedProfile, {
                            currentDayNumber: trueCurrentAppDay
                        });
                        window.showDenioAlert('Future routine updated.');
                        setTimeout(() => window.location.href = 'homepage.html', 900);
                    } catch (error) {
                        console.error('Routine regeneration failed:', error);
                        window.showDenioAlert('Routine generation failed. Please try again.');
                    } finally {
                        btn.disabled = false;
                        btn.innerText = 'GENERATE NEW ROUTINE';
                    }
                });

                document.getElementById('pvSignOutBtn').addEventListener('click', () => {
                    updateUserPresence(user, {
                        isActive: false,
                        lastLogoutAtIso: new Date().toISOString()
                    });
                    createAdminNotification("user_logout", {
                        uid: user.uid,
                        email: user.email,
                        name: profileName
                    });
                    signOut(auth).then(() => {
                        localStorage.removeItem('denio_start_date'); 
                        window.location.href = '../profile/login.html';
                    }).catch((error) => {
                        console.error("Sign out error:", error);
                    });
                });
            }


            // ==========================================
            // COACH JAY: HOMEPAGE & RESULT PAGE LOGIC
            // ==========================================
            const homeCoachMsg = document.getElementById('homeCoachMsg');
            if (homeCoachMsg) {
                try {
                    const signals = await getAdaptiveSignals(user.uid, userData);
                    homeCoachMsg.innerText = buildCoachJayMessage({ context: "home", signals, userData });
                } catch (error) {
                    console.warn("Coach Jay adaptive message fallback:", error);
                    const fallbackMessages = [
                        "Your consistency is paying off. Let's crush today's session!",
                        "Another day, another opportunity to get stronger. Let's go!",
                        "Show up with control today. Clean reps first, progress second."
                    ];
                    homeCoachMsg.innerText = fallbackMessages[Math.floor(Math.random() * fallbackMessages.length)];
                }
            }

            const resultCoachMsg = document.getElementById('resultCoachMsg');
            if (resultCoachMsg) {
                resultCoachMsg.innerText = buildCoachJayMessage({ context: "result", userData });
            }


            // =========================================
            // SESSION PAGE LOGIC
            // =========================================
            if (document.getElementById('sessionWrapper')) {
                initSessionEngine({ user, trueCurrentAppDay });
            }


            // =========================================
            // RESULT PAGE LOGIC (Cloud Save)
            // =========================================
            if (document.getElementById('finishBtn')) {
                initResultEngine({ user, userData, trueCurrentAppDay });
            }


            // =========================================
            // SUMMARY & LIBRARY & CHAT LOGIC
            // =========================================
            if (document.getElementById('aiPredictionText')) {
                await initSummaryEngine({ user, userData });
            }
            
            if (document.getElementById('libraryList')) {
                await initLibraryEngine();
            }

            if (document.getElementById('chatArea')) {
                await initChatEngine({ user, userData });
            }

        } catch (error) {
            console.error("Error fetching user data:", error);
        }

    } else {
        // User is not logged in! Kick them back to login page.
        console.log("No user logged in. Redirecting to login.");
        window.location.href = '../profile/login.html'; // Adjust path if needed
    }
});
