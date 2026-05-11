// js/starting.js

document.addEventListener('DOMContentLoaded', () => {

    // =====================================
    // 1. Scroll Animations (Landing Page)
    // =====================================
    let ticking = false;
    function updateScroll() {
        const scrolled = window.pageYOffset;
        const featuresSection = document.querySelector('.features-section');
        const heroRight = document.querySelector('.hero-right');
        
        if (heroRight) heroRight.classList.add('fade-in');

        if (featuresSection) {
            const featuresTop = featuresSection.offsetTop - (window.innerHeight / 1.5);
            const featureBoxes = document.querySelectorAll('.feature-box');
            
            featureBoxes.forEach(box => {
                if (scrolled > featuresTop) box.classList.add('fade-in');
            });
        }
        ticking = false;
    }

    window.addEventListener('scroll', () => { 
        if (!ticking) {
            requestAnimationFrame(updateScroll);
            ticking = true;
        }
    });
    setTimeout(updateScroll, 100);

    // =====================================
    // 2. Admin Nav Dropdowns
    // =====================================
    const profileBtn = document.getElementById('adminProfileBtn');
    const profileDropdown = document.getElementById('adminDropdown');
    const notifBtn = document.getElementById('notifBtn');
    const notifDropdown = document.getElementById('notifDropdown');

    if (profileBtn) {
        profileBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            profileDropdown.style.display = profileDropdown.style.display === 'flex' ? 'none' : 'flex';
            if (notifDropdown) notifDropdown.style.display = 'none';
        });
    }

    if (notifBtn) {
        notifBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            notifDropdown.style.display = notifDropdown.style.display === 'flex' ? 'none' : 'flex';
            if (profileDropdown) profileDropdown.style.display = 'none';
        });
    }

    const notifItems = document.querySelectorAll('.notif-item.new');
    notifItems.forEach(item => {
        item.addEventListener('click', function() {
            this.classList.remove('new');
            this.classList.add('old');
            const badge = document.getElementById('notifBadge');
            if (badge) {
                let count = parseInt(badge.innerText);
                if (count > 0) {
                    count--;
                    badge.innerText = count;
                    if (count === 0) badge.style.display = 'none';
                }
            }
        });
    });

    document.addEventListener('click', () => {
        if (profileDropdown) profileDropdown.style.display = 'none';
        if (notifDropdown) notifDropdown.style.display = 'none';
    });

    const adminLogoutBtn = document.getElementById('adminLogoutBtn');
    if (adminLogoutBtn) {
        adminLogoutBtn.addEventListener('click', () => {
            if (window.denioAdminModuleLoaded) return;
            window.location.href = '../profile/admin-login.html';
        });
    }

    // =====================================
    // 3. Custom Modals & Toggles
    // =====================================
    const addExBtn = document.getElementById('addExerciseBtn');
    const exModal = document.getElementById('exerciseModal');
    if (addExBtn && exModal && !document.getElementById('adminExerciseList')) {
        addExBtn.addEventListener('click', () => exModal.style.display = 'flex');
        document.getElementById('closeExModal').addEventListener('click', () => exModal.style.display = 'none');
    }

    const addRuleBtn = document.getElementById('addRuleBtn');
    const ruleModal = document.getElementById('ruleModal');
    if (addRuleBtn && ruleModal && !document.getElementById('adminRulesList')) {
        addRuleBtn.addEventListener('click', () => ruleModal.style.display = 'flex');
        document.getElementById('closeRuleModal').addEventListener('click', () => ruleModal.style.display = 'none');
    }

    const muscleFilterBtn = document.getElementById('muscleFilterBtn');
    const muscleFilterMenu = document.getElementById('muscleFilterMenu');
    if (muscleFilterBtn && muscleFilterMenu) {
        muscleFilterBtn.addEventListener('click', (e) => {
            if(e.target === muscleFilterBtn) { 
                muscleFilterMenu.style.display = muscleFilterMenu.style.display === 'flex' ? 'none' : 'flex';
            }
        });
    }

    // =====================================
    // 4. Chip Selection Logic 
    // =====================================
    function applyFullBodyLogic(chipElements) {
        chipElements.forEach(chip => {
            chip.addEventListener('click', function(e) {
                e.stopPropagation();
                const isFullBody = this.innerText.trim().toLowerCase() === 'full body';
                
                if (isFullBody) {
                    if (!this.classList.contains('active')) {
                        chipElements.forEach(c => c.classList.remove('active'));
                        this.classList.add('active');
                    } else {
                        this.classList.remove('active');
                    }
                } else {
                    this.classList.toggle('active');
                    if (this.classList.contains('active')) {
                        const fullBodyChip = Array.from(chipElements).find(c => c.innerText.trim().toLowerCase() === 'full body');
                        if (fullBodyChip) fullBodyChip.classList.remove('active');
                    }
                }
            });
        });
    }

    const filterChips = document.querySelectorAll('.lib-filter-chip');
    if (filterChips.length > 0) applyFullBodyLogic(filterChips);

    const modalFocusChips = document.querySelectorAll('.modal-chip');
    if (modalFocusChips.length > 0) applyFullBodyLogic(modalFocusChips);

    const ruleFocusChips = document.querySelectorAll('.focus-chip');
    if (ruleFocusChips.length > 0) applyFullBodyLogic(ruleFocusChips);

    const goalChips = document.querySelectorAll('.goal-chip');
    goalChips.forEach(chip => {
        chip.addEventListener('click', function() {
            this.classList.toggle('active');
        });
    });

    // =====================================
    // 5. UI Actions (Status Toggles & Edit)
    // =====================================
    document.querySelectorAll('.text-btn-toggle').forEach(btn => {
        btn.addEventListener('click', function() {
            const row = this.closest('tr');
            const pill = row.querySelector('.status-pill');
            
            if(pill.classList.contains('active')) {
                pill.classList.remove('active');
                pill.classList.add('inactive');
                pill.innerText = 'Inactive';
                this.innerText = 'Activate';
            } else {
                pill.classList.remove('inactive');
                pill.classList.add('active');
                pill.innerText = 'Active';
                this.innerText = 'Deactivate';
            }
        });
    });

    document.querySelectorAll('.edit-rule-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const modal = document.getElementById('ruleModal');
            if(modal) modal.style.display = 'flex';
        });
    });
});
