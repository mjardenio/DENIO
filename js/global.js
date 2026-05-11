// js/global.js

document.addEventListener('DOMContentLoaded', () => {
    // Inject the alert HTML without the 'X' button
    const alertHTML = `
        <div id="denioAlert" class="denio-alert-overlay">
            <div class="denio-alert-box">
                <p id="denioAlertMessage" class="denio-alert-text"></p>
            </div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', alertHTML);
});

// Timer variable to prevent overlapping alerts
let alertTimeout;

window.showDenioAlert = function(message) {
    const alertOverlay = document.getElementById('denioAlert');
    const alertMessage = document.getElementById('denioAlertMessage');
    
    // Clear any existing timers so it doesn't close too early if clicked twice
    clearTimeout(alertTimeout);
    
    alertMessage.innerText = message;
    alertOverlay.classList.add('show');
    
    // Automatically fade out after 1.5 seconds (1500ms)
    alertTimeout = setTimeout(() => {
        alertOverlay.classList.remove('show');
    }, 1500); 
}