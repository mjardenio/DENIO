// js/profile.js

document.addEventListener('DOMContentLoaded', () => {
    // === AUTO-FILL STEP 1 ===
    if (document.getElementById('profileName')) {
        if (localStorage.getItem('denio_name')) document.getElementById('profileName').value = localStorage.getItem('denio_name');
        if (localStorage.getItem('denio_age')) document.getElementById('profileAge').value = localStorage.getItem('denio_age');
        if (localStorage.getItem('denio_height')) document.getElementById('profileHeight').value = localStorage.getItem('denio_height');
        if (localStorage.getItem('denio_weight')) document.getElementById('profileWeight').value = localStorage.getItem('denio_weight');
        
        const savedGender = localStorage.getItem('denio_gender');
        if (savedGender) document.querySelectorAll('#genderGroup .segment-btn').forEach(b => { if (b.innerText === savedGender) b.classList.add('selected'); });
        
        const savedLevel = localStorage.getItem('denio_level');
        if (savedLevel) document.querySelectorAll('#levelGroup .level-btn').forEach(b => { if (b.innerText === savedLevel) b.classList.add('selected'); });
    }

    // === AUTO-FILL STEP 2 ===
    if (document.getElementById('freqGroup')) {
        const savedFreq = localStorage.getItem('denio_freq');
        if (savedFreq) document.querySelectorAll('#freqGroup .segment-btn').forEach(b => { if (b.innerText === savedFreq) b.classList.add('selected'); });

        const savedEquip = JSON.parse(localStorage.getItem('denio_equip') || '[]');
        document.querySelectorAll('#equipGroup .sel-btn').forEach(b => {
            if (savedEquip.includes(b.innerText)) b.classList.add('selected');
        });
    }

    // === AUTO-FILL STEP 3 ===
    if (document.getElementById('focusGroup')) {
        const savedFocus = JSON.parse(localStorage.getItem('denio_focus') || '[]');
        document.querySelectorAll('#focusGroup .sel-btn').forEach(b => {
            if (savedFocus.includes(b.innerText)) b.classList.add('selected');
        });

        const savedGoals = JSON.parse(localStorage.getItem('denio_goals') || '[]');
        document.querySelectorAll('#goalGroup .sel-btn').forEach(b => {
            if (savedGoals.includes(b.innerText)) b.classList.add('selected');
        });
    }
});

// Helper function
window.clearTemporaryProfileData = function() {
    const keys = ['denio_name', 'denio_age', 'denio_height', 'denio_weight', 'denio_gender', 'denio_level', 'denio_freq', 'denio_equip', 'denio_focus', 'denio_goals'];
    keys.forEach(key => localStorage.removeItem(key));
}

// =========================================
// PROFILE SETUP STEP 1
// =========================================
window.selectGender = function(btn) {
    document.querySelectorAll('#genderGroup .segment-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
}

window.selectLevel = function(btn) {
    document.querySelectorAll('#levelGroup .level-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
}

window.validateProfile1 = function() {
    var name = document.getElementById('profileName').value.trim();
    var age = document.getElementById('profileAge').value.trim();
    var height = document.getElementById('profileHeight').value.trim();
    var weight = document.getElementById('profileWeight').value.trim();
    
    var genderBtn = document.querySelector('#genderGroup .selected');
    var levelBtn = document.querySelector('#levelGroup .selected');

    if (name === '' || age === '' || height === '' || weight === '') { 
        window.showDenioAlert('Please fill in your Name, Age, Height, and Weight.'); 
    } 
    else if (!genderBtn) { window.showDenioAlert('Please select your Gender.'); } 
    else if (!levelBtn) { window.showDenioAlert('Please select your Fitness Level.'); } 
    else {
        localStorage.setItem('denio_name', name);
        localStorage.setItem('denio_age', age);
        localStorage.setItem('denio_height', height);
        localStorage.setItem('denio_weight', weight);
        localStorage.setItem('denio_gender', genderBtn.innerText);
        localStorage.setItem('denio_level', levelBtn.innerText);
        window.location.href = 'profile-step2.html';
    }
}

// =========================================
// PROFILE SETUP STEP 2
// =========================================
window.selectFreq = function(btn) {
    document.querySelectorAll('#freqGroup .segment-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
}

window.selectEquip = function(btn) {
    var text = btn.textContent;
    var buttons = document.querySelectorAll('#equipGroup .sel-btn');
    if (text === 'FULL GYM' || text === 'NONE') {
        if (btn.classList.contains('selected')) { btn.classList.remove('selected'); return; }
        buttons.forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
    } else {
        buttons.forEach(b => { if (b.textContent === 'FULL GYM' || b.textContent === 'NONE') b.classList.remove('selected'); });
        btn.classList.toggle('selected');
    }
}

window.validateProfile2 = function() {
    var freqBtn = document.querySelector('#freqGroup .selected');
    var equipBtns = document.querySelectorAll('#equipGroup .selected');
    
    if (!freqBtn || equipBtns.length === 0) {
        window.showDenioAlert('Please select your frequency and equipment.');
    } else {
        localStorage.setItem('denio_freq', freqBtn.innerText);
        let equips = Array.from(equipBtns).map(b => b.innerText);
        localStorage.setItem('denio_equip', JSON.stringify(equips));
        window.location.href = 'profile-step3.html';
    }
}

// =========================================
// PROFILE SETUP STEP 3 & TRIGGER AI
// =========================================
window.selectFocus = function(btn) {
    var text = btn.textContent;
    var buttons = document.querySelectorAll('#focusGroup .sel-btn');
    if (text === 'Full Body') {
        if (btn.classList.contains('selected')) { btn.classList.remove('selected'); return; }
        buttons.forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
    } else {
        buttons.forEach(b => { if (b.textContent === 'Full Body') b.classList.remove('selected'); });
        btn.classList.toggle('selected');
    }
}

window.toggleBtn = function(btn) { btn.classList.toggle('selected'); }

window.generatePlan = function() {
    var focusBtns = document.querySelectorAll('#focusGroup .selected');
    var goalBtns = document.querySelectorAll('#goalGroup .selected');

    if (focusBtns.length === 0 || goalBtns.length === 0) {
        window.showDenioAlert("Please select at least one focus area and one goal to proceed.");
        return; 
    }

    // 1. Show Loading Animation instantly
    document.getElementById('step3-content').classList.add('hidden');
    var loadingScreen = document.getElementById('loading-screen');
    if (loadingScreen) {
        loadingScreen.classList.remove('hidden');
        loadingScreen.style.display = 'flex'; 
    }

    // 2. Gather data and save to localStorage
    let focuses = Array.from(focusBtns).map(b => b.innerText);
    let goals = Array.from(goalBtns).map(b => b.innerText);
    
    localStorage.setItem('denio_focus', JSON.stringify(focuses));
    localStorage.setItem('denio_goals', JSON.stringify(goals));
    
    if (!localStorage.getItem('denio_start_date')) {
        localStorage.setItem('denio_start_date', new Date().toISOString());
    }

    // 3. FIRE A CUSTOM EVENT TO WAKE UP THE AI ENGINE!
    console.log("UI: Firing AI Trigger Event...");
    document.dispatchEvent(new Event('triggerDenioAI'));
}