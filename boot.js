// Signed in on this phone: hide the page until app.js has drawn the right screen. Without it
// the customer's booking page (the HTML's own top bar) showed for a moment before the office
// (the owner, 2026-11-16). app.js removes the class after its first render. Signed out, the
// public page shows at once, as before. Its own file: the Content-Security-Policy runs no inline script.
try { if (localStorage.getItem('ws_session')) document.documentElement.classList.add('boot'); } catch (e) {}
