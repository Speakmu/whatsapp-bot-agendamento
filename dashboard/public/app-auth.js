// Configuração do Firebase (centralizada em /firebase-config.js)
const firebaseConfig = window.__FIREBASE_CONFIG__;
if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();

document.addEventListener('DOMContentLoaded', () => {

    const loginButton = document.getElementById('login-button');
    const emailInput = document.getElementById('email-input');
    const passwordInput = document.getElementById('password-input');
    const errorMessage = document.getElementById('error-message');

    // Se já estiver logado, vai direto para a home
    auth.onAuthStateChanged((user) => {
        if (user) {
            window.location.href = '/home.html';
        }
    });

    loginButton.addEventListener('click', () => {
        const email = emailInput.value;
        const password = passwordInput.value;
        errorMessage.textContent = '';

        auth.signInWithEmailAndPassword(email, password)
            .then(() => {
                window.location.href = '/home.html';
            })
            .catch((error) => {
                const errorCode = error.code;
                console.error("Erro de Login:", errorCode);
                if (errorCode === 'auth/wrong-password' || errorCode === 'auth/user-not-found' || errorCode === 'auth/invalid-email') {
                    errorMessage.textContent = 'Erro de Login: Email ou senha inválidos.';
                } else {
                    errorMessage.textContent = 'Ocorreu um erro. Tente novamente.';
                }
            });
    });
});
