// Configuração do Firebase
function resolveFirebaseConfig() {
    const candidate = window.QUIZ_MASTER_FIREBASE_CONFIG;
    if (candidate && typeof candidate === 'object') {
        return candidate;
    }

    // Compatibilidade: permite que uma variavel global generica seja usada.
    const legacy = window.firebaseConfig;
    if (legacy && typeof legacy === 'object') {
        return legacy;
    }

    return null;
}

const firebaseConfig = resolveFirebaseConfig();

if (!firebaseConfig) {
    const message = 'Configuracao do Firebase ausente. Crie public/config.js a partir de public/config.example.js.';
    console.error(message);
    throw new Error(message);
}

// Inicializar Firebase
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

// Configurar persistência de sessão
auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL)
    .catch((error) => {
        console.error('Erro ao configurar persistência:', error);
    });

// Estado da aplicação
let currentUser = null;
let currentQuiz = null;
let currentQuestions = [];
let currentQuestionIndex = 0;
let userAnswers = [];
let quizTimer = null;
let timeRemaining = 0;
let totalTime = 0;
let userQuizId = null;
let editingQuizId = null;
let editingQuestionId = null;
let editingUserId = null;
let exitCount = 0;
let quizStartTime = 0;
let availableStudents = [];
let selectedStudents = [];
let quizActive = false;
let quizProtectionEnabled = false;
let quizShieldTimer = null;
let quizPrintMediaQuery = null;
let lastProgressSyncAt = 0;
let reviewDataQuizId = null;
let reviewDataUserQuizId = null;

const QUIZ_STATE_PREFIX = 'quizState:';
const QUIZ_PROGRESS_SYNC_MS = 15000;
const QUIZ_SHIELD_DURATION_MS = 1500;

// Cache para dados de ranking (para permitir pesquisa)
let cachedRankingData = {
    student: { ranking: [], usersMap: {} },
    admin: { ranking: [], usersMap: {} }
};
let cachedQuizRankingData = {
    student: { quiz: null, results: [], usersMap: {} },
    admin: { quiz: null, results: [], usersMap: {} }
};

// Elementos da DOM
const authContainer = document.getElementById('auth-container');
const studentDashboard = document.getElementById('student-dashboard');
const adminDashboard = document.getElementById('admin-dashboard');
const quizContainer = document.getElementById('quiz-container');
const quizResult = document.getElementById('quiz-result');
const loading = document.getElementById('loading');
const quizScreenshotShield = document.getElementById('quiz-screenshot-shield');

function getQuizStateKey(userId, quizId) {
    return `${QUIZ_STATE_PREFIX}${userId}:${quizId}`;
}

function getTimestampMs(value) {
    if (!value) return null;
    if (typeof value === 'number') return value;
    if (value.toDate) return value.toDate().getTime();
    const parsed = new Date(value);
    const ms = parsed.getTime();
    return Number.isNaN(ms) ? null : ms;
}

function computeRemainingFromSaved(timeValue, savedAtMs) {
    if (typeof timeValue !== 'number') return 0;
    if (!savedAtMs) return Math.max(0, timeValue);
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - savedAtMs) / 1000));
    return Math.max(0, timeValue - elapsedSeconds);
}

function normalizeAnswers(answers, length) {
    const normalized = Array.isArray(answers) ? answers.slice(0, length) : [];
    while (normalized.length < length) {
        normalized.push(null);
    }
    return normalized;
}

function saveQuizStateLocal(options = {}) {
    if (!currentUser || !currentQuiz || !userQuizId) return;
    const state = {
        userId: currentUser.uid,
        quizId: currentQuiz.id,
        userQuizId: userQuizId,
        answers: Array.isArray(userAnswers) ? userAnswers : [],
        currentQuestionIndex: typeof currentQuestionIndex === 'number' ? currentQuestionIndex : 0,
        timeRemaining: typeof timeRemaining === 'number' ? timeRemaining : 0,
        exitCount: typeof exitCount === 'number' ? exitCount : 0,
        questionIds: Array.isArray(currentQuestions) ? currentQuestions.map(question => question.id).filter(Boolean) : [],
        savedAt: Date.now(),
        active: typeof options.active === 'boolean' ? options.active : quizActive
    };

    try {
        localStorage.setItem(getQuizStateKey(currentUser.uid, currentQuiz.id), JSON.stringify(state));
    } catch (error) {
        console.warn('Nao foi possivel salvar o estado do quiz localmente:', error);
    }
}

function getActiveQuizStateForUser(userId) {
    try {
        let latestState = null;
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (!key || !key.startsWith(`${QUIZ_STATE_PREFIX}${userId}:`)) continue;
            const raw = localStorage.getItem(key);
            if (!raw) continue;
            const parsed = JSON.parse(raw);
            if (!parsed || parsed.userId !== userId || !parsed.active) continue;
            if (!latestState || (parsed.savedAt && parsed.savedAt > latestState.savedAt)) {
                latestState = parsed;
            }
        }
        return latestState;
    } catch (error) {
        console.warn('Nao foi possivel ler o estado do quiz localmente:', error);
        return null;
    }
}

function getQuizStateForUser(userId, quizId) {
    if (!userId || !quizId) return null;
    try {
        const raw = localStorage.getItem(getQuizStateKey(userId, quizId));
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || parsed.userId !== userId || parsed.quizId !== quizId) return null;
        return parsed;
    } catch (error) {
        console.warn('Nao foi possivel ler o estado do quiz localmente:', error);
        return null;
    }
}

function clearQuizStateLocal(userId, quizId) {
    if (!userId || !quizId) return;
    try {
        localStorage.removeItem(getQuizStateKey(userId, quizId));
    } catch (error) {
        console.warn('Nao foi possivel limpar o estado do quiz localmente:', error);
    }
}

function syncQuizProgress(force = false) {
    const now = Date.now();
    if (!force && now - lastProgressSyncAt < QUIZ_PROGRESS_SYNC_MS) return;
    lastProgressSyncAt = now;
    updateUserQuizProgress();
}

function handleQuizGuardedEvent(event) {
    if (!quizActive) return;
    event.preventDefault();
    event.stopPropagation();
}

function handleQuizKeydown(event) {
    if (!quizActive) return;
    const key = (event.key || '').toLowerCase();
    const isModifierBlocked = (event.ctrlKey || event.metaKey) && ['a', 'c', 'x', 's', 'p'].includes(key);
    const isPrintCommand = (event.ctrlKey || event.metaKey) && key === 'p';
    const isPrintScreen = event.key === 'PrintScreen';
    if (isModifierBlocked || isPrintScreen) {
        event.preventDefault();
        event.stopPropagation();
    }
    if (isPrintCommand || isPrintScreen) {
        showQuizShield();
    }
}

function isQuizShieldEnabled() {
    return quizActive && currentUser && currentUser.userType === 'aluno';
}

function showQuizShield(durationMs = QUIZ_SHIELD_DURATION_MS) {
    if (!isQuizShieldEnabled()) return;
    if (quizShieldTimer) {
        clearTimeout(quizShieldTimer);
        quizShieldTimer = null;
    }
    document.body.classList.add('quiz-shield-active');
    if (quizScreenshotShield) {
        quizScreenshotShield.classList.remove('hidden');
    }
    if (durationMs > 0) {
        quizShieldTimer = setTimeout(() => {
            hideQuizShield();
        }, durationMs);
    }
}

function hideQuizShield() {
    if (quizShieldTimer) {
        clearTimeout(quizShieldTimer);
        quizShieldTimer = null;
    }
    document.body.classList.remove('quiz-shield-active');
    if (quizScreenshotShield) {
        quizScreenshotShield.classList.add('hidden');
    }
}

function handleQuizBeforePrint() {
    showQuizShield();
}

function handleQuizAfterPrint() {
    hideQuizShield();
}

function handleQuizPrintMediaChange(event) {
    if (!isQuizShieldEnabled()) return;
    if (event.matches) {
        showQuizShield();
    } else {
        hideQuizShield();
    }
}

function handleQuizVisibilityChange() {
    if (!isQuizShieldEnabled()) return;
    if (document.visibilityState === 'visible') {
        showQuizShield();
    }
}

function handleQuizWindowFocus() {
    showQuizShield();
}

function handleQuizWindowBlur() {
    if (!isQuizShieldEnabled()) return;
    showQuizShield(500);
}

function enableQuizProtection() {
    if (quizProtectionEnabled) return;
    quizProtectionEnabled = true;
    document.addEventListener('copy', handleQuizGuardedEvent, true);
    document.addEventListener('cut', handleQuizGuardedEvent, true);
    document.addEventListener('paste', handleQuizGuardedEvent, true);
    document.addEventListener('contextmenu', handleQuizGuardedEvent, true);
    document.addEventListener('selectstart', handleQuizGuardedEvent, true);
    document.addEventListener('dragstart', handleQuizGuardedEvent, true);
    document.addEventListener('keydown', handleQuizKeydown, true);
    window.addEventListener('beforeprint', handleQuizBeforePrint);
    window.addEventListener('afterprint', handleQuizAfterPrint);
    document.addEventListener('visibilitychange', handleQuizVisibilityChange);
    window.addEventListener('focus', handleQuizWindowFocus);
    window.addEventListener('blur', handleQuizWindowBlur);
    if (window.matchMedia) {
        quizPrintMediaQuery = window.matchMedia('print');
        if (quizPrintMediaQuery.addEventListener) {
            quizPrintMediaQuery.addEventListener('change', handleQuizPrintMediaChange);
        } else if (quizPrintMediaQuery.addListener) {
            quizPrintMediaQuery.addListener(handleQuizPrintMediaChange);
        }
    }
}

function disableQuizProtection() {
    if (!quizProtectionEnabled) return;
    quizProtectionEnabled = false;
    document.removeEventListener('copy', handleQuizGuardedEvent, true);
    document.removeEventListener('cut', handleQuizGuardedEvent, true);
    document.removeEventListener('paste', handleQuizGuardedEvent, true);
    document.removeEventListener('contextmenu', handleQuizGuardedEvent, true);
    document.removeEventListener('selectstart', handleQuizGuardedEvent, true);
    document.removeEventListener('dragstart', handleQuizGuardedEvent, true);
    document.removeEventListener('keydown', handleQuizKeydown, true);
    window.removeEventListener('beforeprint', handleQuizBeforePrint);
    window.removeEventListener('afterprint', handleQuizAfterPrint);
    document.removeEventListener('visibilitychange', handleQuizVisibilityChange);
    window.removeEventListener('focus', handleQuizWindowFocus);
    window.removeEventListener('blur', handleQuizWindowBlur);
    if (quizPrintMediaQuery) {
        if (quizPrintMediaQuery.removeEventListener) {
            quizPrintMediaQuery.removeEventListener('change', handleQuizPrintMediaChange);
        } else if (quizPrintMediaQuery.removeListener) {
            quizPrintMediaQuery.removeListener(handleQuizPrintMediaChange);
        }
        quizPrintMediaQuery = null;
    }
}

function setQuizActive(active, options = {}) {
    quizActive = !!active;
    if (quizActive) {
        hideQuizShield();
        quizContainer.classList.add('quiz-protected');
        document.body.classList.add('quiz-print-blocked');
        enableQuizProtection();
        saveQuizStateLocal({ active: true });
        return;
    }

    hideQuizShield();
    quizContainer.classList.remove('quiz-protected');
    document.body.classList.remove('quiz-print-blocked');
    disableQuizProtection();

    if (options.clearLocal && currentUser && currentQuiz) {
        clearQuizStateLocal(currentUser.uid, currentQuiz.id);
    } else if (options.persist !== false) {
        saveQuizStateLocal({ active: false });
    }
}

function handleQuizBeforeUnload() {
    if (!quizActive) return;
    saveQuizStateLocal({ active: true });
    syncQuizProgress(true);
}

function resumeQuizFromState(quiz, localState) {
    if (!localState || !localState.userQuizId) return Promise.resolve(false);
    currentQuiz = quiz;

    return db.collection('userQuizzes').doc(localState.userQuizId).get()
        .then(doc => {
            if (!doc.exists) {
                clearQuizStateLocal(localState.userId, localState.quizId);
                return false;
            }

            const userQuiz = doc.data();
            if (userQuiz.status !== 'in-progress') {
                clearQuizStateLocal(localState.userId, localState.quizId);
                return false;
            }

            const serverUpdatedAt = getTimestampMs(userQuiz.updatedAt) || getTimestampMs(userQuiz.startTime) || 0;
            const localSavedAt = localState.savedAt || 0;
            const preferLocal = localSavedAt >= serverUpdatedAt;
            const base = preferLocal ? localState : userQuiz;
            const fallback = preferLocal ? userQuiz : localState;

            const rawTime = typeof base.timeRemaining === 'number'
                ? base.timeRemaining
                : (typeof fallback.timeRemaining === 'number' ? fallback.timeRemaining : (quiz.time * 60));
            const baseSavedAt = preferLocal ? localSavedAt : (serverUpdatedAt || localSavedAt);

            timeRemaining = computeRemainingFromSaved(rawTime, baseSavedAt);
            exitCount = typeof base.exitCount === 'number'
                ? base.exitCount
                : (typeof fallback.exitCount === 'number' ? fallback.exitCount : 0);
            currentQuestionIndex = typeof base.currentQuestionIndex === 'number'
                ? base.currentQuestionIndex
                : (typeof fallback.currentQuestionIndex === 'number' ? fallback.currentQuestionIndex : 0);
            userAnswers = Array.isArray(base.answers) && base.answers.length
                ? base.answers
                : (Array.isArray(fallback.answers) ? fallback.answers : []);

            userQuizId = doc.id;

            const questionIds = Array.isArray(base.questionIds) && base.questionIds.length
                ? base.questionIds
                : (Array.isArray(fallback.questionIds) ? fallback.questionIds : []);

            return loadQuizQuestions(quiz.id, { questionIds, preserveAnswers: true, resume: true });
        })
        .catch(error => {
            console.error('Erro ao retomar quiz:', error);
            return false;
        });
}

function attemptAutoResumeQuiz() {
    if (!currentUser || currentUser.userType !== 'aluno') return Promise.resolve(false);
    const state = getActiveQuizStateForUser(currentUser.uid);
    if (!state) return Promise.resolve(false);

    return db.collection('quizzes').doc(state.quizId).get()
        .then(doc => {
            if (!doc.exists) {
                clearQuizStateLocal(state.userId, state.quizId);
                return false;
            }
            const quiz = { id: doc.id, ...doc.data() };
            return resumeQuizFromState(quiz, state);
        })
        .catch(error => {
            console.error('Erro ao tentar retomar quiz automaticamente:', error);
            return false;
        });
}

// Inicializar a aplicação
document.addEventListener('DOMContentLoaded', function() {
    initAuth();
    initEventListeners();
    initModals();
    
    // Verificar se há um usuário logado
    auth.onAuthStateChanged(user => {
        if (user) {
            // Usuário está logado
            showLoading();
            ensureUserDocument(user).then(userData => {
                // Verificar se o usuário está ativo
                if (userData.status === 'inactive' && userData.userType === 'aluno') {
                    auth.signOut();
                    hideLoading();
                    alert('Sua conta foi desativada. Entre em contato com o administrador.');
                    return;
                }
                
                currentUser = { ...user, ...userData };
                hideLoading();
                showDashboard();
            }).catch(error => {
                hideLoading();
                console.error('Erro ao carregar dados do usuário:', error);
                auth.signOut();
                showAuth();
                showError('login-error', getAuthErrorMessage(error));
            });
        } else {
            // Nenhum usuário logado
            hideLoading();
            showAuth();
        }
    });
    // Tratar resultado de redirect (fallback quando popup for bloqueado)
    auth.getRedirectResult()
        .then((result) => {
            if (result && result.user) {
                // Garantir documento do usuário para login social via redirect
                ensureUserDocument(result.user)
                    .then(userData => {
                        if (userData && userData.status === 'inactive' && userData.userType === 'aluno') {
                            return auth.signOut().then(() => {
                                hideLoading();
                                showError('login-error', 'Sua conta foi desativada. Entre em contato com o administrador.');
                            });
                        }

                        document.getElementById('login-error').textContent = '';
                        hideLoading();
                    })
                    .catch(err => {
                        console.error('Erro ao garantir documento do usuário (redirect):', err);
                        hideLoading();
                    });
            }
        })
        .catch(error => {
            console.error('Erro ao processar getRedirectResult:', error);
            // Mostrar erro amigável
            hideLoading();
            showError('login-error', getAuthErrorMessage(error));
        });
});

// Funções de loading
function showLoading() {
    loading.classList.remove('hidden');
}

function hideLoading() {
    loading.classList.add('hidden');
}

// Inicializar autenticação
function initAuth() {
    const loginTab = document.getElementById('login-tab');
    const registerTab = document.getElementById('register-tab');
    const loginForm = document.getElementById('login-form');
    const registerForm = document.getElementById('register-form');
    const forgotPasswordLink = document.getElementById('forgot-password');
    const googleLoginBtn = document.getElementById('google-login-btn');
    
    // Alternar entre login e cadastro
    loginTab.addEventListener('click', () => {
        switchAuthTab('login');
    });
    
    registerTab.addEventListener('click', () => {
        switchAuthTab('register');
        checkAdminExists();
    });
    
    // Login com submit do formulário
    loginForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const email = document.getElementById('login-email').value;
        const password = document.getElementById('login-password').value;
        
        if (!email || !password) {
            showError('login-error', 'Por favor, preencha todos os campos.');
            return;
        }
        
        showLoading();
        auth.signInWithEmailAndPassword(email, password)
            .then((userCredential) => ensureUserDocument(userCredential.user))
            .then(userData => {
                if (userData.status === 'inactive' && userData.userType === 'aluno') {
                    auth.signOut();
                    hideLoading();
                    showError('login-error', 'Sua conta foi desativada. Entre em contato com o administrador.');
                    return;
                }
                
                // Login bem-sucedido
                document.getElementById('login-error').textContent = '';
                hideLoading();
            })
            .catch((error) => {
                console.error('Erro no login com e-mail e senha:', error);
                hideLoading();
                showError('login-error', getAuthErrorMessage(error));
            });
    });
    
    // Cadastro com submit do formulário
    registerForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const name = document.getElementById('register-name').value;
        const email = document.getElementById('register-email').value;
        const password = document.getElementById('register-password').value;
        const userType = document.getElementById('register-type').value;
        
        if (!name || !email || !password) {
            showError('register-error', 'Por favor, preencha todos os campos.');
            return;
        }
        
        if (password.length < 6) {
            showError('register-error', 'A senha deve ter pelo menos 6 caracteres.');
            return;
        }
        
        // Verificar se já existe administrador
        if (userType === 'admin') {
            checkAdminExists().then(adminExists => {
                if (adminExists) {
                    showError('register-error', 'Já existe um administrador cadastrado. Não é possível criar outro.');
                    return;
                } else {
                    registerUser(name, email, password, userType);
                }
            });
        } else {
            registerUser(name, email, password, userType);
        }
    });
    
    // Recuperação de senha
    forgotPasswordLink.addEventListener('click', (e) => {
        e.preventDefault();
        const email = document.getElementById('login-email').value;
        if (!email) {
            alert('Por favor, insira seu e-mail para recuperar a senha.');
            return;
        }
        
        auth.sendPasswordResetEmail(email)
            .then(() => {
                alert('E-mail de recuperação enviado! Verifique sua caixa de entrada.');
            })
            .catch(error => {
                alert('Erro ao enviar e-mail de recuperação: ' + getAuthErrorMessage(error));
            });
    });
    
    // Login com Google
    if (googleLoginBtn) {
        googleLoginBtn.addEventListener('click', () => {
            signInWithGoogle();
        });
    }

    // Toggle password visibility
    document.getElementById('toggle-login-password').addEventListener('click', function() {
        togglePasswordVisibility('login-password', this);
    });
    
    document.getElementById('toggle-register-password').addEventListener('click', function() {
        togglePasswordVisibility('register-password', this);
    });

    // Permitir Enter para navegar entre campos
    document.getElementById('login-email').addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            document.getElementById('login-password').focus();
        }
    });

    document.getElementById('login-password').addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            document.getElementById('login-btn').click();
        }
    });

    // Para o formulário de cadastro
    const registerFields = ['register-name', 'register-email', 'register-password'];
    registerFields.forEach((fieldId, index) => {
        document.getElementById(fieldId).addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                if (index < registerFields.length - 1) {
                    document.getElementById(registerFields[index + 1]).focus();
                } else {
                    document.getElementById('register-btn').click();
                }
            }
        });
    });
}

// Alternar visibilidade da senha
function togglePasswordVisibility(passwordFieldId, toggleIcon) {
    const passwordField = document.getElementById(passwordFieldId);
    const type = passwordField.getAttribute('type') === 'password' ? 'text' : 'password';
    passwordField.setAttribute('type', type);
    
    // Alterar ícone
    toggleIcon.classList.toggle('fa-eye');
    toggleIcon.classList.toggle('fa-eye-slash');
}

// Verificar se já existe administrador
function checkAdminExists() {
    return db.collection('users')
        .where('userType', '==', 'admin')
        .get()
        .then(querySnapshot => {
            const adminOption = document.getElementById('admin-option');
            if (!querySnapshot.empty) {
                // Já existe administrador, desabilitar opção
                adminOption.disabled = true;
                adminOption.textContent = 'Administrador (Já existe)';
                return true;
            } else {
                // Não existe administrador, habilitar opção
                adminOption.disabled = false;
                adminOption.textContent = 'Administrador';
                return false;
            }
        })
        .catch(error => {
            console.error('Erro ao verificar administradores:', error);
            return false;
        });
}

// Alternar entre abas de autenticação
function switchAuthTab(tab) {
    const loginTab = document.getElementById('login-tab');
    const registerTab = document.getElementById('register-tab');
    const loginForm = document.getElementById('login-form');
    const registerForm = document.getElementById('register-form');
    
    if (tab === 'login') {
        loginTab.classList.add('active');
        registerTab.classList.remove('active');
        loginForm.classList.add('active');
        registerForm.classList.remove('active');
    } else {
        registerTab.classList.add('active');
        loginTab.classList.remove('active');
        registerForm.classList.add('active');
        loginForm.classList.remove('active');
    }
}

// Registrar novo usuário
function registerUser(name, email, password, userType) {
    showLoading();
    auth.createUserWithEmailAndPassword(email, password)
        .then((userCredential) => {
            const user = userCredential.user;
            
            // Salvar dados adicionais do usuário no Firestore
            return db.collection('users').doc(user.uid).set({
                name: name,
                email: email,
                userType: userType,
                status: 'active',
                createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            });
        })
        .then(() => {
            hideLoading();
            document.getElementById('register-error').textContent = '';
            showSuccess('register-error', 'Cadastro realizado com sucesso!');
            
            // Limpar formulário e mudar para login após 2 segundos
            setTimeout(() => {
                document.getElementById('register-form').reset();
                switchAuthTab('login');
            }, 2000);
        })
        .catch((error) => {
            console.error('Erro ao registrar usuario:', error);
            hideLoading();
            showError('register-error', getAuthErrorMessage(error));
        });
}

// Obter dados do usuário
// Garantir documento do usuario para login social
function ensureUserDocument(user) {
    return db.collection('users').doc(user.uid).get()
        .then(doc => {
            if (doc.exists) {
                return doc.data();
            }

            const fallbackName = user.displayName || (user.email ? user.email.split('@')[0] : 'Aluno');
            const userData = {
                name: fallbackName,
                email: user.email || '',
                userType: 'aluno',
                status: 'active',
                createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            };

            return db.collection('users').doc(user.uid).set(userData).then(() => userData);
        });
}

// Login com Google
function signInWithGoogle() {
    const provider = new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });

    showLoading();
    auth.signInWithPopup(provider)
        .then((result) => ensureUserDocument(result.user))
        .then(userData => {
            if (userData && userData.status === 'inactive' && userData.userType === 'aluno') {
                return auth.signOut().then(() => {
                    hideLoading();
                    showError('login-error', 'Sua conta foi desativada. Entre em contato com o administrador.');
                });
            }

            document.getElementById('login-error').textContent = '';
            hideLoading();
        })
        .catch((error) => {
            console.error('Erro no login com Google:', error);

            // Erro comum: provedor Google não habilitado no Firebase (operation-not-allowed)
            if (error && error.code === 'auth/operation-not-allowed') {
                hideLoading();
                showError('login-error', 'Login com Google não habilitado no projeto Firebase. Habilite o provedor Google em Firebase Console > Authentication > Sign-in method e adicione o domínio (ex: localhost).');
                return;
            }

            // Popup bloqueado ou similar: tentar fallback para redirect
            if (error && (error.code === 'auth/popup-blocked' || error.code === 'auth/popup-closed-by-user' || error.code === 'auth/cancelled-popup-request')) {
                console.warn('Popup bloqueado ou fechado. Tentando fallback com redirect...');
                // Não chamamos hideLoading() aqui porque será tratado no redirect flow
                auth.signInWithRedirect(provider);
                return;
            }

            hideLoading();
            showError('login-error', getAuthErrorMessage(error));
        });
}

function getUserData(uid) {
    return db.collection('users').doc(uid).get()
        .then(doc => {
            if (doc.exists) {
                return doc.data();
            } else {
                throw new Error('Usuário não encontrado');
            }
        });
}

// Inicializar event listeners
function initEventListeners() {
    // Logout
    document.getElementById('student-logout').addEventListener('click', logout);
    document.getElementById('admin-logout').addEventListener('click', logout);
    
    // Navegação entre abas
    initTabNavigation();
    
    // Controles do quiz
    initQuizControls();
    
    // Navegação dos resultados
    document.getElementById('back-to-dashboard').addEventListener('click', () => {
        showDashboard();
    });
    
    document.getElementById('new-quiz').addEventListener('click', () => {
        showDashboard();
        setTimeout(() => {
            if (currentUser.userType === 'aluno') {
                switchTab('quizzes-tab', 'quizzes-section');
                loadQuizzes();
            }
        }, 100);
    });
    
    document.getElementById('review-quiz').addEventListener('click', handleReviewClick);
    
    // Botões do admin
    document.getElementById('create-quiz-btn').addEventListener('click', () => openQuizModal());
    document.getElementById('create-question-btn').addEventListener('click', () => openQuestionModal());
    document.getElementById('import-questions-btn').addEventListener('click', openImportModal);
    
    // Inicializar página sobre se existir
    if (document.getElementById('about-section')) {
        initAboutPage();
    }

    // Inicializar listeners de pesquisa
    initSearchListeners();

    window.addEventListener('beforeunload', handleQuizBeforeUnload);
    window.addEventListener('pagehide', handleQuizBeforeUnload);
}

// Inicializar listeners de pesquisa
function initSearchListeners() {
    // Pesquisa no Ranking Geral
    document.getElementById('ranking-search')?.addEventListener('input', (e) => filterRanking(e.target.value, 'student'));
    document.getElementById('admin-ranking-search')?.addEventListener('input', (e) => filterRanking(e.target.value, 'admin'));

    // Pesquisa no Ranking por Quiz
    document.getElementById('quiz-master-search')?.addEventListener('input', (e) => filterQuizRanking(e.target.value, 'student'));
    document.getElementById('admin-quiz-master-search')?.addEventListener('input', (e) => filterQuizRanking(e.target.value, 'admin'));

    // Pesquisa na lista de usuários do admin
    document.getElementById('admin-users-search')?.addEventListener('input', (e) => filterAdminUsers(e.target.value));
}

// Inicializar navegação por abas
function initTabNavigation() {
    // Abas do aluno
    document.getElementById('quizzes-tab').addEventListener('click', () => {
        switchTab('quizzes-tab', 'quizzes-section');
        loadQuizzes();
    });
    
    document.getElementById('ranking-tab').addEventListener('click', () => {
        switchTab('ranking-tab', 'ranking-section');
        loadRanking();
    });
    
    document.getElementById('quiz-masters-tab').addEventListener('click', () => {
        switchTab('quiz-masters-tab', 'quiz-masters-section');
        loadQuizRankings();
    });
    
    document.getElementById('history-tab').addEventListener('click', () => {
        switchTab('history-tab', 'history-section');
        loadUserHistory();
    });
    
    document.getElementById('about-tab').addEventListener('click', () => {
        switchTab('about-tab', 'about-section');
    });
    
    // Abas do admin
    document.getElementById('admin-quizzes-tab').addEventListener('click', () => {
        switchAdminTab('admin-quizzes-tab', 'admin-quizzes-section');
        loadAdminQuizzes();
    });
    
    document.getElementById('admin-questions-tab').addEventListener('click', () => {
        switchAdminTab('admin-questions-tab', 'admin-questions-section');
        loadAdminQuestions();
    });
    
    document.getElementById('admin-users-tab').addEventListener('click', () => {
        switchAdminTab('admin-users-tab', 'admin-users-section');
        loadAdminUsers();
    });
    
    document.getElementById('admin-ranking-tab').addEventListener('click', () => {
        switchAdminTab('admin-ranking-tab', 'admin-ranking-section');
        loadAdminRanking();
    });
    
    document.getElementById('admin-quiz-masters-tab').addEventListener('click', () => {
        switchAdminTab('admin-quiz-masters-tab', 'admin-quiz-masters-section');
        loadAdminQuizRankings();
    });
    
    document.getElementById('admin-reports-tab').addEventListener('click', () => {
        switchAdminTab('admin-reports-tab', 'admin-reports-section');
        loadAdminReports();
    });
    
    document.getElementById('admin-about-tab').addEventListener('click', () => {
        switchAdminTab('admin-about-tab', 'admin-about-section');
    });
    
    // Botão de sair do quiz
    document.getElementById('exit-quiz-btn').addEventListener('click', confirmExitQuiz);
}

// Inicializar controles do quiz
function initQuizControls() {
    document.getElementById('prev-question').addEventListener('click', () => {
        if (currentQuestionIndex > 0) {
            currentQuestionIndex--;
            displayQuestion();
        }
    });
    
    document.getElementById('next-question').addEventListener('click', () => {
        if (currentQuestionIndex < currentQuestions.length - 1) {
            currentQuestionIndex++;
            displayQuestion();
        }
    });
    
    document.getElementById('finish-quiz').addEventListener('click', () => {
        finishQuiz();
    });
    
    // Seleção de opções
    document.querySelectorAll('.option').forEach(option => {
        option.addEventListener('click', function() {
            const selectedValue = this.getAttribute('data-value');
            selectOption(selectedValue);
        });
    });
}

// Inicializar modals
function initModals() {
    // Modal do quiz
    document.getElementById('close-quiz-modal').addEventListener('click', closeQuizModal);
    document.getElementById('cancel-quiz').addEventListener('click', closeQuizModal);
    document.getElementById('save-quiz').addEventListener('click', saveQuiz);
    
    // Modal da questão
    document.getElementById('close-question-modal').addEventListener('click', closeQuestionModal);
    document.getElementById('cancel-question').addEventListener('click', closeQuestionModal);
    document.getElementById('save-question').addEventListener('click', saveQuestion);
    
    // Modal do usuário
    document.getElementById('close-user-modal').addEventListener('click', closeUserModal);
    document.getElementById('cancel-user').addEventListener('click', closeUserModal);
    document.getElementById('save-user').addEventListener('click', saveUser);
    
    // Modal de importação
    document.getElementById('close-import-modal').addEventListener('click', closeImportModal);
    document.getElementById('cancel-import').addEventListener('click', closeImportModal);
    document.getElementById('import-questions').addEventListener('click', importQuestions);
    
    // Modal de revisão
    document.getElementById('close-review-modal').addEventListener('click', closeReviewModal);
    document.getElementById('close-review').addEventListener('click', closeReviewModal);
    
    // Fechar modals ao clicar fora
    document.querySelectorAll('.modal').forEach(modal => {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.classList.add('hidden');
            }
        });
    });
    
    // Event listeners para a visibilidade do quiz
    document.getElementById('quiz-visibility').addEventListener('change', function() {
        const specificStudentsContainer = document.getElementById('specific-students-container');
        if (this.value === 'specific') {
            specificStudentsContainer.classList.remove('hidden');
            loadAvailableStudents();
        } else {
            specificStudentsContainer.classList.add('hidden');
            selectedStudents = [];
            updateSelectedStudentsDisplay();
        }
    });
    
    // Event listener para busca de alunos
    document.getElementById('student-search')?.addEventListener('input', function() {
        filterAvailableStudents(this.value);
    });
    
    // Event listener para seleção de quiz no ranking
    document.getElementById('quiz-master-select')?.addEventListener('change', function() {
        loadSpecificQuizRanking(this.value);
    });
    
    document.getElementById('admin-quiz-master-select')?.addEventListener('change', function() {
        loadAdminSpecificQuizRanking(this.value);
    });
}

// Inicializar página sobre
function initAboutPage() {
    const reportBugBtn = document.getElementById('report-bug');
    if (reportBugBtn) {
        reportBugBtn.addEventListener('click', function(e) {
            e.preventDefault();
            openBugReportModal();
        });
    }
}

// Função para abrir modal de reportar bug
function openBugReportModal() {
    const email = 'luizynho27@email.com';
    const subject = 'Reportar Bug - QuizMaster';
    const body = `Olá,\n\nEncontrei um bug no QuizMaster:\n\n• Descrição do problema:\n• Passos para reproduzir:\n• Comportamento esperado:\n• Comportamento atual:\n\nInformações do sistema:\n- Navegador: ${navigator.userAgent}\n- Resolução: ${screen.width}x${screen.height}\n\nObrigado!`;
    
    window.open(`mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`);
}

// Alternar entre abas do aluno
function switchTab(tabId, sectionId) {
    // Remover classe active de todas as abas e seções
    const tabs = document.querySelectorAll('#student-dashboard .dashboard-header .tab');
    const sections = document.querySelectorAll('#student-dashboard .dashboard-content .section');
    
    tabs.forEach(tab => tab.classList.remove('active'));
    sections.forEach(section => section.classList.remove('active'));
    
    // Adicionar classe active à aba e seção selecionadas
    document.getElementById(tabId).classList.add('active');
    document.getElementById(sectionId).classList.add('active');
}

// Alternar entre abas do admin
function switchAdminTab(tabId, sectionId) {
    // Remover classe active de todas as abas e seções
    const tabs = document.querySelectorAll('#admin-dashboard .dashboard-header .tab');
    const sections = document.querySelectorAll('#admin-dashboard .dashboard-content .section');
    
    tabs.forEach(tab => tab.classList.remove('active'));
    sections.forEach(section => section.classList.remove('active'));
    
    // Adicionar classe active à aba e seção selecionadas
    document.getElementById(tabId).classList.add('active');
    document.getElementById(sectionId).classList.add('active');
}

// Mostrar tela de autenticação
function showAuth() {
    setQuizActive(false, { persist: false });
    authContainer.classList.remove('hidden');
    studentDashboard.classList.add('hidden');
    adminDashboard.classList.add('hidden');
    quizContainer.classList.add('hidden');
    quizResult.classList.add('hidden');
}

// Mostrar dashboard apropriado
function showDashboard() {
    authContainer.classList.add('hidden');
    quizContainer.classList.add('hidden');
    quizResult.classList.add('hidden');
    
    if (currentUser.userType === 'admin') {
        studentDashboard.classList.add('hidden');
        adminDashboard.classList.remove('hidden');
        document.getElementById('admin-name').textContent = currentUser.name;
        loadAdminQuizzes();
    } else {
        adminDashboard.classList.add('hidden');
        studentDashboard.classList.remove('hidden');
        document.getElementById('student-name').textContent = currentUser.name;
        attemptAutoResumeQuiz().then(resumed => {
            if (!resumed) {
                loadQuizzes();
            }
        });
    }
}

// Fazer logout
function logout() {
    showLoading();
    auth.signOut().then(() => {
        currentUser = null;
        hideLoading();
        showAuth();
    });
}

// Mostrar erro
function showError(elementId, message) {
    const element = document.getElementById(elementId);
    element.textContent = message;
    element.className = 'error-message';
}

// Mostrar sucesso
function showSuccess(elementId, message) {
    const element = document.getElementById(elementId);
    element.textContent = message;
    element.className = 'success-message';
}

// Obter mensagem de erro amigável
function getAuthErrorMessage(error) {
    const errorCode = typeof error === 'string' ? error : error?.code;
    const messages = {
        'auth/invalid-email': 'E-mail inválido.',
        'auth/user-disabled': 'Esta conta foi desativada.',
        'auth/user-not-found': 'Nenhuma conta encontrada com este e-mail.',
        'auth/wrong-password': 'Senha incorreta.',
        'auth/invalid-credential': 'E-mail ou senha inválidos.',
        'auth/email-already-in-use': 'Este e-mail já está em uso.',
        'auth/weak-password': 'A senha é muito fraca.',
        'auth/operation-not-allowed': 'Operação não permitida. Verifique se o provedor de login está habilitado no Firebase Authentication.',
        'auth/unauthorized-domain': 'Domínio não autorizado no Firebase Authentication. Adicione o domínio atual em Authentication > Settings > Authorized domains.',
        'auth/api-key-not-valid': 'Chave de API do Firebase inválida. Confira a configuração do app Web no Firebase Console.',
        'auth/invalid-api-key': 'Chave de API do Firebase inválida. Confira a configuração do app Web no Firebase Console.',
        'auth/popup-closed-by-user': 'Login cancelado. Tente novamente.',
        'auth/cancelled-popup-request': 'Outra janela de login ja esta aberta.',
        'auth/popup-blocked': 'Pop-up bloqueado pelo navegador. Libere o pop-up e tente novamente.',
        'auth/account-exists-with-different-credential': 'Ja existe uma conta com este e-mail. Entre com e-mail e senha e vincule o Google nas configuracoes.',
        'auth/too-many-requests': 'Muitas tentativas. Tente novamente mais tarde.',
        'permission-denied': 'Sem permissão para acessar o Firestore. Verifique as regras do banco e se o usuário está autenticado.',
        'not-found': 'Registro do usuário não encontrado no Firestore.',
        'unavailable': 'Firebase indisponível no momento. Verifique sua conexão e tente novamente.',
        'invalid-argument': 'Configuração inválida do Firebase. Confira projectId, apiKey e appId no Firebase Console.',
        'failed-precondition': 'O Firestore precisa de uma configuração/índice antes de concluir essa operação.',
        'resource-exhausted': 'Limite do Firebase excedido no momento. Tente novamente mais tarde.'
    };
    
    return messages[errorCode] || (errorCode ? `Ocorreu um erro (${errorCode}). Tente novamente.` : 'Ocorreu um erro. Tente novamente.');
}

// ===============================
// GERENCIAMENTO DE QUIZZES
// ===============================

// Carregar quizzes para alunos
function loadQuizzes() {
    const quizzesList = document.getElementById('quizzes-list');
    quizzesList.innerHTML = '<div class="card"><div class="card-content">Carregando quizzes...</div></div>';
    
    // Buscar quizzes ativos
    db.collection('quizzes')
        .where('status', '==', 'active')
        .get()
        .then(querySnapshot => {
            quizzesList.innerHTML = '';
            
            if (querySnapshot.empty) {
                quizzesList.innerHTML = '<div class="card"><div class="card-content">Nenhum quiz disponível no momento.</div></div>';
                return;
            }
            
            const userQuizzesPromises = [];
            const quizzesData = [];
            
            querySnapshot.forEach(doc => {
                const quiz = { id: doc.id, ...doc.data() };
                quizzesData.push(quiz);
                
                // Verificar se o quiz é visível para este aluno
                const visibilityCheck = checkQuizVisibility(quiz, currentUser.uid);
                userQuizzesPromises.push(visibilityCheck);
            });
            
            // Esperar todas as verificações de visibilidade
            Promise.all(userQuizzesPromises).then(visibilityResults => {
                quizzesList.innerHTML = '';
                
                let hasVisibleQuizzes = false;
                
                quizzesData.forEach((quiz, index) => {
                    if (visibilityResults[index]) {
                        hasVisibleQuizzes = true;
                        const quizCard = createQuizCard(quiz);
                        quizzesList.appendChild(quizCard);
                    }
                });
                
                if (!hasVisibleQuizzes) {
                    quizzesList.innerHTML = '<div class="card"><div class="card-content">Nenhum quiz disponível para você no momento.</div></div>';
                }
            });
        })
        .catch(error => {
            quizzesList.innerHTML = '<div class="card"><div class="card-content">Erro ao carregar quizzes.</div></div>';
            console.error('Erro ao carregar quizzes:', error);
        });
}

// Verificar se o quiz é visível para o aluno
function checkQuizVisibility(quiz, userId) {
    return new Promise((resolve) => {
        // Se o quiz for para todos os alunos, é visível
        if (quiz.visibility === 'all') {
            resolve(true);
            return;
        }
        
        // Se for para alunos específicos, verificar se o aluno está na lista
        if (quiz.visibility === 'specific' && quiz.allowedStudents) {
            resolve(quiz.allowedStudents.includes(userId));
            return;
        }
        
        // Se não houver configuração de visibilidade, assume-se que é para todos
        resolve(true);
    });
}

// Criar card de quiz para alunos
function createQuizCard(quiz) {
    const card = document.createElement('div');
    card.className = 'card';
    
    // Verificar se o usuário já iniciou este quiz
    const userQuizRef = db.collection('userQuizzes')
        .where('userId', '==', currentUser.uid)
        .where('quizId', '==', quiz.id)
        .where('status', 'in', ['in-progress', 'completed']);
    
    userQuizRef.get().then(querySnapshot => {
        let buttonText = 'Iniciar Quiz';
        let buttonClass = 'btn btn-primary';
        let statusText = 'Não iniciado';
        let statusClass = 'card-badge';
        
        if (!querySnapshot.empty) {
            const userQuiz = querySnapshot.docs[0].data();
            userQuizId = querySnapshot.docs[0].id;
            
            if (userQuiz.status === 'in-progress') {
                buttonText = 'Continuar Quiz';
                buttonClass = 'btn btn-success';
                statusText = 'Em andamento';
                statusClass = 'card-badge';
            } else if (userQuiz.status === 'completed') {
                buttonText = 'Ver Resultado';
                buttonClass = 'btn btn-secondary';
                statusText = 'Concluído';
                statusClass = 'card-badge';
            }
        }
        
        card.innerHTML = `
            <div class="card-header">
                <h3 class="card-title">${quiz.title}</h3>
                <span class="${statusClass}">${statusText}</span>
            </div>
            <div class="card-content">
                <p>${quiz.description || 'Sem descrição'}</p>
            </div>
            <div class="card-meta">
                <span><i class="fas fa-clock"></i> ${quiz.time} min</span>
                <span><i class="fas fa-question-circle"></i> ${quiz.questionsCount} questões</span>
                <span><i class="fas fa-layer-group"></i> ${quiz.category || 'Geral'}</span>
            </div>
            <div class="card-actions">
                <button class="${buttonClass}" data-quiz-id="${quiz.id}">
                    <i class="fas fa-play"></i>
                    <span class="btn-text">${buttonText}</span>
                </button>
            </div>
        `;
        
        const button = card.querySelector('button');
        button.addEventListener('click', () => {
            if (buttonText === 'Ver Resultado') {
                showQuizResult(quiz.id);
            } else {
                startQuiz(quiz);
            }
        });
    });
    
    return card;
}

// ===============================
// QUIZ - EXECUÇÃO
// ===============================

// Iniciar quiz
function startQuiz(quiz) {
    currentQuiz = quiz;
    userAnswers = new Array(quiz.questionsCount).fill(null);
    currentQuestionIndex = 0;
    exitCount = 0;
    
    // Verificar se já existe um quiz em andamento
    db.collection('userQuizzes')
        .where('userId', '==', currentUser.uid)
        .where('quizId', '==', quiz.id)
        .where('status', '==', 'in-progress')
        .get()
        .then(querySnapshot => {
            if (!querySnapshot.empty) {
                // Continuar quiz existente
                const userQuizDoc = querySnapshot.docs[0];
                userQuizId = userQuizDoc.id;
                const userQuiz = userQuizDoc.data();
                
                userAnswers = userQuiz.answers || new Array(quiz.questionsCount).fill(null);
                currentQuestionIndex = userQuiz.currentQuestionIndex || 0;
                exitCount = userQuiz.exitCount || 0;
                timeRemaining = typeof userQuiz.timeRemaining === 'number' ? userQuiz.timeRemaining : (quiz.time * 60);
                const localState = getQuizStateForUser(currentUser.uid, quiz.id);
                const questionIds = Array.isArray(userQuiz.questionIds) && userQuiz.questionIds.length
                    ? userQuiz.questionIds
                    : (localState && Array.isArray(localState.questionIds) ? localState.questionIds : []);
                
                // Buscar questões do quiz
                loadQuizQuestions(quiz.id, { questionIds, preserveAnswers: true });
            } else {
                // Criar novo registro do quiz do usuário
                timeRemaining = quiz.time * 60;
                
                db.collection('userQuizzes').add({
                    userId: currentUser.uid,
                    quizId: quiz.id,
                    status: 'in-progress',
                    answers: userAnswers,
                    currentQuestionIndex: 0,
                    timeRemaining: timeRemaining,
                    exitCount: 0,
                    startTime: firebase.firestore.FieldValue.serverTimestamp(),
                    attempts: 1,
                    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                })
                .then((docRef) => {
                    userQuizId = docRef.id;
                    // Buscar questões do quiz
                    loadQuizQuestions(quiz.id);
                });
            }
        })
        .catch(error => {
            alert('Erro ao iniciar quiz: ' + error.message);
        });
}

// Carregar questões do quiz
function applyQuizQuestions(questions, options = {}) {
    currentQuestions = questions;
    const questionCount = currentQuestions.length;

    if (options.preserveAnswers) {
        userAnswers = normalizeAnswers(userAnswers, questionCount);
    } else {
        userAnswers = new Array(questionCount).fill(null);
    }

    if (currentQuestionIndex >= questionCount) {
        currentQuestionIndex = 0;
    }

    if (userQuizId && questionCount > 0) {
        db.collection('userQuizzes').doc(userQuizId).update({
            questionIds: currentQuestions.map(question => question.id).filter(Boolean),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        })
        .catch(error => {
            console.error('Erro ao salvar questoes do quiz:', error);
        });
    }

    reviewDataQuizId = currentQuiz ? currentQuiz.id : null;
    reviewDataUserQuizId = userQuizId || null;

    showQuiz();
}

function loadQuizQuestions(quizId, options = {}) {
    showLoading();

    const questionIds = Array.isArray(options.questionIds) ? options.questionIds.filter(Boolean) : [];
    if (questionIds.length > 0) {
        const questionFetches = questionIds.map(questionId => db.collection('questions').doc(questionId).get());

        return Promise.all(questionFetches)
            .then(docs => {
                hideLoading();

                const questions = docs
                    .filter(doc => doc.exists)
                    .map(doc => ({ id: doc.id, ...doc.data() }))
                    .filter(question => question.text);

                if (questions.length == 0) {
                    alert('Nenhuma questao disponivel para este quiz. Tente selecionar outra categoria.');
                    return false;
                }

                applyQuizQuestions(questions, { preserveAnswers: options.preserveAnswers });
                return true;
            })
            .catch(error => {
                hideLoading();
                console.error('Erro detalhado ao carregar questoes:', error);
                alert('Erro ao carregar questoes: ' + error.message);
                return false;
            });
    }

    // Buscar questoes baseado na categoria do quiz
    let questionsQuery = db.collection('questions');

    // Se o quiz tem uma categoria especifica, filtrar por ela
    if (currentQuiz.category && currentQuiz.category.trim() !== '') {
        questionsQuery = questionsQuery.where('category', '==', currentQuiz.category);
    }

    return questionsQuery.get()
        .then(querySnapshot => {
            hideLoading();

            if (querySnapshot.empty) {
                alert('Nenhuma questao disponivel para este quiz. Tente selecionar outra categoria.');
                return false;
            }

            const allQuestions = [];
            querySnapshot.forEach(doc => {
                const question = { id: doc.id, ...doc.data() };
                // Garantir que a questao tem o campo 'text' (enunciado)
                if (question.text) {
                    allQuestions.push(question);
                }
            });

            // Selecionar questoes aleatorias
            const questionCount = Math.min(currentQuiz.questionsCount, allQuestions.length);

            // Embaralhar questoes usando Fisher-Yates
            const shuffledQuestions = [...allQuestions];
            for (let i = shuffledQuestions.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [shuffledQuestions[i], shuffledQuestions[j]] = [shuffledQuestions[j], shuffledQuestions[i]];
            }

            // Selecionar as primeiras N questoes
            const selectedQuestions = shuffledQuestions.slice(0, questionCount);

            applyQuizQuestions(selectedQuestions, { preserveAnswers: options.preserveAnswers });
            return true;
        })
        .catch(error => {
            hideLoading();
            console.error('Erro detalhado ao carregar questoes:', error);
            alert('Erro ao carregar questoes: ' + error.message);
            return false;
        });
}

// Mostrar tela do quiz
function showQuiz() {
    authContainer.classList.add('hidden');
    studentDashboard.classList.add('hidden');
    adminDashboard.classList.add('hidden');
    quizResult.classList.add('hidden');
    quizContainer.classList.remove('hidden');
    setQuizActive(true);
    
    // Configurar informações do quiz
    document.getElementById('quiz-title-display').textContent = currentQuiz.title;
    document.getElementById('quiz-description-display').textContent = currentQuiz.description || '';
    
    // Iniciar timer
    totalTime = currentQuiz.time * 60;
    startTimer();
    
    // Exibir primeira questão
    displayQuestion();
}

// Iniciar timer do quiz
function startTimer() {
    updateTimerDisplay();
    quizStartTime = Date.now();

    if (quizTimer) {
        clearInterval(quizTimer);
        quizTimer = null;
    }

    if (timeRemaining <= 0) {
        finishQuiz();
        return;
    }

    quizTimer = setInterval(() => {
        timeRemaining = Math.max(0, timeRemaining - 1);
        updateTimerDisplay();
        saveQuizStateLocal({ active: true });
        syncQuizProgress();

        if (timeRemaining <= 0) {
            finishQuiz();
        }
    }, 1000);
}

// Atualizar display do timer
function updateTimerDisplay() {
    const minutes = Math.floor(timeRemaining / 60);
    const seconds = timeRemaining % 60;
    const timerText = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    document.getElementById('quiz-timer').textContent = timerText;
    
    // Atualizar progresso do círculo do timer
    const progress = document.getElementById('timer-progress');
    const circumference = 2 * Math.PI * 28;
    const offset = circumference - (timeRemaining / totalTime) * circumference;
    progress.style.strokeDashoffset = offset;
}

// Função auxiliar para atualizar progresso do quiz
function updateQuizProgress() {
    const progress = ((currentQuestionIndex + 1) / currentQuestions.length) * 100;
    const progressFill = document.getElementById('progress-fill');
    const progressText = document.getElementById('quiz-progress-text');
    const currentQuestionElement = document.getElementById('current-question');
    const totalQuestionsElement = document.getElementById('total-questions');
    
    if (progressFill) progressFill.style.width = `${progress}%`;
    if (progressText) progressText.textContent = `Questão ${currentQuestionIndex + 1}/${currentQuestions.length}`;
    if (currentQuestionElement) currentQuestionElement.textContent = currentQuestionIndex + 1;
    if (totalQuestionsElement) totalQuestionsElement.textContent = currentQuestions.length;
}

// Função auxiliar para atualizar botões de navegação
function updateNavigationButtons() {
    const prevButton = document.getElementById('prev-question');
    const nextButton = document.getElementById('next-question');
    const finishButton = document.getElementById('finish-quiz');
    
    if (prevButton) prevButton.disabled = currentQuestionIndex === 0;
    if (nextButton) nextButton.style.display = currentQuestionIndex === currentQuestions.length - 1 ? 'none' : 'flex';
    if (finishButton) finishButton.classList.toggle('hidden', currentQuestionIndex !== currentQuestions.length - 1);
}

// Exibir questão atual
function displayQuestion() {
    if (!currentQuestions || currentQuestions.length === 0 || currentQuestionIndex >= currentQuestions.length) {
        console.error('Nenhuma questão disponível para exibir ou índice inválido');
        return;
    }
    
    const question = currentQuestions[currentQuestionIndex];
    
    // Exibir o enunciado da questão (campo 'text')
    const questionTextElement = document.getElementById('question-text');
    const optionATextElement = document.getElementById('option-a-text');
    const optionBTextElement = document.getElementById('option-b-text');
    const optionCTextElement = document.getElementById('option-c-text');
    const optionDTextElement = document.getElementById('option-d-text');
    
    if (questionTextElement) {
        questionTextElement.textContent = question.text || 'Questão sem texto definido';
    }
    
    if (optionATextElement) {
        optionATextElement.textContent = question.options?.a || 'Opção A não definida';
    }
    
    if (optionBTextElement) {
        optionBTextElement.textContent = question.options?.b || 'Opção B não definida';
    }
    
    if (optionCTextElement) {
        optionCTextElement.textContent = question.options?.c || 'Opção C não definida';
    }
    
    if (optionDTextElement) {
        optionDTextElement.textContent = question.options?.d || 'Opção D não definida';
    }
    
    // Atualizar progresso
    updateQuizProgress();
    
    // Limpar seleção anterior
    document.querySelectorAll('.option').forEach(option => {
        option.classList.remove('selected');
    });
    
    // Restaurar resposta salva, se houver
    if (userAnswers[currentQuestionIndex]) {
        const selectedOption = document.querySelector(`.option[data-value="${userAnswers[currentQuestionIndex]}"]`);
        if (selectedOption) {
            selectedOption.classList.add('selected');
        }
    }
    
    // Atualizar estado dos botões de navegação
    updateNavigationButtons();
    saveQuizStateLocal({ active: true });
    syncQuizProgress();
}

// Selecionar opção
function selectOption(value) {
    // Limpar seleção anterior
    document.querySelectorAll('.option').forEach(option => {
        option.classList.remove('selected');
    });
    
    // Selecionar nova opção
    const selectedOption = document.querySelector(`.option[data-value="${value}"]`);
    selectedOption.classList.add('selected');
    
    // Salvar resposta
    userAnswers[currentQuestionIndex] = value;
    
    // Atualizar no Firestore
    updateUserQuizProgress();
    saveQuizStateLocal({ active: true });
}

// Atualizar progresso do quiz do usuário
function updateUserQuizProgress() {
    if (!userQuizId) return;

    const updateData = {
        answers: userAnswers,
        currentQuestionIndex: currentQuestionIndex,
        timeRemaining: timeRemaining,
        exitCount: exitCount,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        lastClientSyncAt: Date.now()
    };

    if (Array.isArray(currentQuestions) && currentQuestions.length > 0) {
        updateData.questionIds = currentQuestions.map(question => question.id).filter(Boolean);
    }

    db.collection('userQuizzes').doc(userQuizId).update(updateData)
    .catch(error => {
        console.error('Erro ao atualizar progresso do quiz:', error);
    });
}

// Confirmar saída do quiz
function confirmExitQuiz() {
    if (exitCount >= 1) {
        // Segunda saída - finalizar quiz automaticamente e voltar para aba de Quizzes
        if (confirm('Esta é sua segunda saída do quiz. O quiz será finalizado automaticamente com as questões respondidas até agora. Deseja continuar?')) {
            finishQuiz(true); // Forçar finalização
            // Após finalizar, voltar para a aba de Quizzes
            setTimeout(() => {
                showDashboard();
                if (currentUser.userType === 'aluno') {
                    switchTab('quizzes-tab', 'quizzes-section');
                    loadQuizzes();
                }
            }, 100);
        }
    } else {
        // Primeira saída
        if (confirm('Tem certeza que deseja sair do quiz? Seu progresso será salvo e você poderá continuar depois.')) {
            exitCount++;
            clearInterval(quizTimer);
            quizTimer = null;
            setQuizActive(false);
            
            // Atualizar contador de saídas
            db.collection('userQuizzes').doc(userQuizId).update({
                exitCount: exitCount,
                timeRemaining: timeRemaining,
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            })
            .then(() => {
                showDashboard();
            });
        }
    }
}

// Função finishQuiz
function finishQuiz(forced = false) {
    console.log('Finalizando quiz...', { forced, userQuizId, currentQuestions, userAnswers });

    setQuizActive(false, { clearLocal: true });
    
    // Parar o timer
    if (quizTimer) {
        clearInterval(quizTimer);
        quizTimer = null;
    }
    
    // Calcular pontuação
    let score = 0;
    let answeredQuestions = 0;
    
    if (currentQuestions && userAnswers) {
        currentQuestions.forEach((question, index) => {
            if (userAnswers[index]) {
                answeredQuestions++;
                if (userAnswers[index] === question.correctAnswer) {
                    score++;
                }
            }
        });
    }
    
    const timeTaken = totalTime - timeRemaining;
    const percentage = forced ? 
        (answeredQuestions > 0 ? (score / answeredQuestions) * 100 : 0) : 
        (currentQuestions.length > 0 ? (score / currentQuestions.length) * 100 : 0);
    
    console.log('Resultado calculado:', { score, answeredQuestions, percentage, timeTaken });
    
    // Se não temos userQuizId, mostrar resultado diretamente
    if (!userQuizId) {
        console.warn('userQuizId não encontrado, mostrando resultado diretamente');
        showQuizResult(currentQuiz.id, score, percentage, timeTaken, forced);
        return;
    }
    
    // Atualizar status do quiz do usuário
    db.collection('userQuizzes').doc(userQuizId).update({
        status: 'completed',
        score: score,
        percentage: percentage,
        timeTaken: timeTaken,
        completedAt: firebase.firestore.FieldValue.serverTimestamp(),
        forcedCompletion: forced || false
    })
    .then(() => {
        console.log('Quiz finalizado com sucesso no Firestore');
        // Mostrar resultado
        showQuizResult(currentQuiz.id, score, percentage, timeTaken, forced);
    })
    .catch(error => {
        console.error('Erro ao finalizar quiz no Firestore:', error);
        // Mostrar resultado mesmo com erro
        showQuizResult(currentQuiz.id, score, percentage, timeTaken, forced);
    });
}

// Mostrar resultado do quiz
function showQuizResult(quizId, score = null, percentage = null, timeTaken = null, forced = false) {
    console.log('Mostrando resultado:', { quizId, score, percentage, timeTaken, forced });

    if (score !== null && percentage !== null && timeTaken !== null) {
        // Exibir resultado rec?m-calculado
        const minutes = Math.floor(timeTaken / 60);
        const seconds = timeTaken % 60;
        const timeText = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;

        document.getElementById('score-percentage').textContent = `${percentage.toFixed(1)}%`;

        // Calcular answeredQuestions corretamente
        let answeredQuestions = 0;
        if (userAnswers) {
            answeredQuestions = userAnswers.filter(answer => answer !== null).length;
        }

        if (forced) {
            document.getElementById('score-fraction').textContent = `${score}/${currentQuestions.length} (${answeredQuestions} respondidas)`;
            document.getElementById('result-subtitle').textContent = 'Quiz finalizado - Algumas quest?es n?o foram respondidas';
        } else {
            document.getElementById('score-fraction').textContent = `${score}/${currentQuestions.length}`;
            document.getElementById('result-subtitle').textContent = 'Veja como voc? foi';
        }

        document.getElementById('correct-answers').textContent = score;
        document.getElementById('wrong-answers').textContent = forced ?
            (answeredQuestions - score) :
            (currentQuestions.length - score);
        document.getElementById('time-taken').textContent = timeText;

        // Animar o c?rculo de progresso
        const circleProgress = document.getElementById('circle-progress');
        const degrees = (percentage / 100) * 360;
        if (circleProgress) {
            circleProgress.style.transform = `rotate(${degrees}deg)`;
        }

        // Calcular posi??o no ranking
        calculateRankingPosition(quizId, percentage);

        // Verificar se a revis?o de respostas est? permitida
        const reviewButton = document.getElementById('review-quiz');
        if (currentQuiz && currentQuiz.allowReview === false) {
            // Desabilitar bot?o de revis?o
            reviewButton.disabled = true;
            reviewButton.innerHTML = '<i class="fas fa-lock"></i><span class="btn-text">Revisão Bloqueada</span>';
            reviewButton.classList.remove('btn-secondary');
            reviewButton.classList.add('btn-danger');
        } else {
            // Habilitar bot?o de revis?o
            reviewButton.disabled = false;
            reviewButton.innerHTML = '<i class="fas fa-redo"></i><span class="btn-text">Revisar Respostas</span>';
            reviewButton.classList.remove('btn-danger');
            reviewButton.classList.add('btn-secondary');
        }

        quizContainer.classList.add('hidden');
        quizResult.classList.remove('hidden');
    } else {
        // Buscar resultado salvo
        db.collection('userQuizzes')
            .where('userId', '==', currentUser.uid)
            .where('quizId', '==', quizId)
            .where('status', '==', 'completed')
            .get()
            .then(querySnapshot => {
                if (querySnapshot.empty) {
                    return;
                }

                const userQuizDoc = querySnapshot.docs[0];
                const userQuiz = userQuizDoc.data();

                return db.collection('quizzes').doc(quizId).get()
                    .then(quizDoc => {
                        const quizData = quizDoc.exists ? { id: quizDoc.id, ...quizDoc.data() } : { id: quizId };
                        currentQuiz = quizData;
                        reviewDataQuizId = quizId;
                        reviewDataUserQuizId = userQuizDoc.id;

                        const questionIds = Array.isArray(userQuiz.questionIds)
                            ? userQuiz.questionIds.filter(Boolean)
                            : [];

                        let totalQuestions = questionIds.length;
                        if (!totalQuestions) {
                            if (Array.isArray(userQuiz.answers) && userQuiz.answers.length) {
                                totalQuestions = userQuiz.answers.length;
                            } else if (typeof quizData.questionsCount === 'number') {
                                totalQuestions = quizData.questionsCount;
                            } else {
                                totalQuestions = currentQuestions.length || 0;
                            }
                        }

                        const safeTimeTaken = typeof userQuiz.timeTaken === 'number' ? userQuiz.timeTaken : 0;
                        const minutes = Math.floor(safeTimeTaken / 60);
                        const seconds = safeTimeTaken % 60;
                        const timeText = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;

                        document.getElementById('score-percentage').textContent = `${userQuiz.percentage.toFixed(1)}%`;
                        document.getElementById('score-fraction').textContent = `${userQuiz.score}/${totalQuestions}`;
                        document.getElementById('correct-answers').textContent = userQuiz.score;
                        document.getElementById('wrong-answers').textContent = Math.max(totalQuestions - userQuiz.score, 0);
                        document.getElementById('time-taken').textContent = timeText;

                        // Animar o c?rculo de progresso
                        const circleProgress = document.getElementById('circle-progress');
                        const degrees = (userQuiz.percentage / 100) * 360;
                        if (circleProgress) {
                            circleProgress.style.transform = `rotate(${degrees}deg)`;
                        }

                        // Calcular posi??o no ranking
                        calculateRankingPosition(quizId, userQuiz.percentage);

                        // Verificar se a revis?o de respostas est? permitida
                        const reviewButton = document.getElementById('review-quiz');
                        if (quizData && quizData.allowReview === false) {
                            // Desabilitar bot?o de revis?o
                            reviewButton.disabled = true;
                            reviewButton.innerHTML = '<i class="fas fa-lock"></i><span class="btn-text">Revisão Bloqueada</span>';
                            reviewButton.classList.remove('btn-secondary');
                            reviewButton.classList.add('btn-danger');
                        } else {
                            // Habilitar bot?o de revis?o
                            reviewButton.disabled = false;
                            reviewButton.innerHTML = '<i class="fas fa-redo"></i><span class="btn-text">Revisar Respostas</span>';
                            reviewButton.classList.remove('btn-danger');
                            reviewButton.classList.add('btn-secondary');
                        }

                        quizContainer.classList.add('hidden');
                        quizResult.classList.remove('hidden');
                    });
            })
            .catch(error => {
                console.error('Erro ao buscar resultado salvo:', error);
                // Em caso de erro, voltar para o dashboard
                showDashboard();
            });
    }
}

// Calcular posição no ranking
function calculateRankingPosition(quizId, percentage) {
    db.collection('userQuizzes')
        .where('quizId', '==', quizId)
        .where('status', '==', 'completed')
        .get()
        .then(querySnapshot => {
            const rankings = [];
            querySnapshot.forEach(doc => {
                const userQuiz = doc.data();
                rankings.push({
                    userId: userQuiz.userId,
                    percentage: userQuiz.percentage
                });
            });
            
            // Ordenar por porcentagem (decrescente)
            rankings.sort((a, b) => b.percentage - a.percentage);
            
            // Encontrar posição do usuário atual
            const userPosition = rankings.findIndex(ranking => ranking.userId === currentUser.uid) + 1;
            const totalPlayers = rankings.length;
            
            document.getElementById('ranking-position').textContent = userPosition > 0 ? 
                `${userPosition}º de ${totalPlayers}` : '-';
        })
        .catch(error => {
            console.error('Erro ao calcular ranking:', error);
            document.getElementById('ranking-position').textContent = '-';
        });
}

// Abrir revisao de respostas (garante dados corretos)
function handleReviewClick() {
    const reviewButton = document.getElementById('review-quiz');
    if (reviewButton && reviewButton.disabled) return;

    if (!currentUser || currentUser.userType !== 'aluno') return;
    if (!currentQuiz || !currentQuiz.id) {
        alert('Quiz nao identificado para revisao.');
        return;
    }

    if (currentQuiz.allowReview === false) {
        alert('A revisao de respostas esta bloqueada para este quiz.');
        return;
    }

    const quizId = currentQuiz.id;

    if (reviewDataQuizId === quizId && Array.isArray(currentQuestions) && currentQuestions.length > 0) {
        showReviewModal();
        return;
    }

    if (reviewDataQuizId === quizId && reviewDataUserQuizId) {
        loadReviewData(reviewDataUserQuizId, quizId);
        return;
    }

    db.collection('userQuizzes')
        .where('userId', '==', currentUser.uid)
        .where('quizId', '==', quizId)
        .where('status', '==', 'completed')
        .get()
        .then(querySnapshot => {
            if (querySnapshot.empty) {
                alert('Resultado nao encontrado para revisao.');
                return;
            }

            const completedQuizId = querySnapshot.docs[0].id;
            reviewDataUserQuizId = completedQuizId;
            loadReviewData(completedQuizId, quizId);
        })
        .catch(error => {
            console.error('Erro ao buscar resultado para revisao:', error);
            alert('Erro ao carregar dados para revisao.');
        });
}

// Mostrar modal de revisão
function showReviewModal() {
    const reviewContent = document.getElementById('review-content');
    reviewContent.innerHTML = '';
    
    currentQuestions.forEach((question, index) => {
        const userAnswer = userAnswers[index];
        const isCorrect = userAnswer === question.correctAnswer;
        
        const reviewItem = document.createElement('div');
        reviewItem.className = `review-item ${isCorrect ? 'correct' : 'wrong'}`;
        reviewItem.innerHTML = `
            <div class="review-question">
                <h4>Questão ${index + 1}</h4>
                <p>${question.text}</p>
            </div>
            <div class="review-answers">
                <div class="review-answer ${userAnswer === 'a' ? 'user-answer' : ''} ${question.correctAnswer === 'a' ? 'correct-answer' : ''}">
                    <strong>A:</strong> ${question.options.a}
                </div>
                <div class="review-answer ${userAnswer === 'b' ? 'user-answer' : ''} ${question.correctAnswer === 'b' ? 'correct-answer' : ''}">
                    <strong>B:</strong> ${question.options.b}
                </div>
                <div class="review-answer ${userAnswer === 'c' ? 'user-answer' : ''} ${question.correctAnswer === 'c' ? 'correct-answer' : ''}">
                    <strong>C:</strong> ${question.options.c}
                </div>
                <div class="review-answer ${userAnswer === 'd' ? 'user-answer' : ''} ${question.correctAnswer === 'd' ? 'correct-answer' : ''}">
                    <strong>D:</strong> ${question.options.d}
                </div>
            </div>
            <div class="review-result">
                <strong>Sua resposta:</strong> ${userAnswer ? userAnswer.toUpperCase() : 'Não respondida'} 
                ${isCorrect ? '✓ Correto' : '✗ Incorreto'}
                ${!isCorrect ? `<br><strong>Resposta correta:</strong> ${question.correctAnswer.toUpperCase()}` : ''}
            </div>
        `;
        
        reviewContent.appendChild(reviewItem);
    });
    
    document.getElementById('review-modal').classList.remove('hidden');
}

// Fechar modal de revisão
function closeReviewModal() {
    document.getElementById('review-modal').classList.add('hidden');
}

// ===============================
// HISTÓRICO
// ===============================

// Carregar histórico do usuário
function loadUserHistory() {
    const historyList = document.getElementById('history-list');
    historyList.innerHTML = '<div class="card"><div class="card-content">Carregando histórico...</div></div>';
    
    console.log('🔍 Iniciando carregamento do histórico...');
    
    db.collection('userQuizzes')
        .where('userId', '==', currentUser.uid)
        .where('status', '==', 'completed')
        .get()
        .then(querySnapshot => {
            console.log('✅ Consulta bem-sucedida. Documentos encontrados:', querySnapshot.size);
            
            historyList.innerHTML = '';
            
            if (querySnapshot.empty) {
                console.log('ℹ️ Nenhum quiz concluído encontrado');
                historyList.innerHTML = `
                    <div class="card">
                        <div class="card-content">
                            <div style="text-align: center; padding: 2rem;">
                                <i class="fas fa-inbox" style="font-size: 3rem; color: #6c757d; margin-bottom: 1rem;"></i>
                                <h3>Nenhum quiz concluído ainda</h3>
                                <p>Complete alguns quizzes para ver seu histórico aqui!</p>
                            </div>
                        </div>
                    </div>
                `;
                return;
            }
            
            const userQuizzes = [];
            querySnapshot.forEach(doc => {
                const data = doc.data();
                console.log('📄 Documento:', doc.id, data);
                
                userQuizzes.push({
                    id: doc.id,
                    quizId: data.quizId,
                    score: data.score || 0,
                    percentage: data.percentage || 0,
                    timeTaken: data.timeTaken || 0,
                    answers: data.answers || [],
                    completedAt: data.completedAt || data.updatedAt || data.startTime,
                    attempts: data.attempts || 1
                });
            });
            
            // Ordenar localmente por data (mais recente primeiro)
            userQuizzes.sort((a, b) => {
                const dateA = a.completedAt ? (a.completedAt.toDate ? a.completedAt.toDate() : new Date(a.completedAt)) : new Date(0);
                const dateB = b.completedAt ? (b.completedAt.toDate ? b.completedAt.toDate() : new Date(b.completedAt)) : new Date(0);
                return dateB - dateA;
            });
            
            console.log('🔄 Buscando informações dos quizzes...');
            
            // Buscar todos os quizzes de uma vez
            db.collection('quizzes').get()
                .then(quizzesSnapshot => {
                    const quizzesMap = {};
                    quizzesSnapshot.forEach(doc => {
                        const quizData = doc.data();
                        quizzesMap[doc.id] = {
                            id: doc.id,
                            title: quizData.title || 'Quiz sem título',
                            description: quizData.description || 'Sem descrição',
                            questionsCount: quizData.questionsCount || 0,
                            category: quizData.category || 'Geral',
                            time: quizData.time || 0,
                            allowReview: quizData.allowReview !== false // Padrão: true
                        };
                    });
                    
                    console.log('🎯 Quizzes disponíveis no sistema:', Object.keys(quizzesMap));
                    
                    // Criar cards de histórico
                    let cardsCriados = 0;
                    userQuizzes.forEach(userQuiz => {
                        const quiz = quizzesMap[userQuiz.quizId];
                        
                        if (quiz) {
                            cardsCriados++;
                            createHistoryCard(historyList, userQuiz, quiz);
                        } else {
                            console.log('❌ Quiz não encontrado:', userQuiz.quizId);
                            // Criar card mesmo sem informações do quiz
                            createFallbackHistoryCard(historyList, userQuiz);
                        }
                    });
                    
                    // Se nenhum card foi criado, mostrar mensagem
                    if (cardsCriados === 0 && userQuizzes.length > 0) {
                        userQuizzes.forEach(userQuiz => {
                            createFallbackHistoryCard(historyList, userQuiz);
                        });
                    }
                    
                    // Adicionar gráfico de desempenho se houver dados
                    if (userQuizzes.length > 0) {
                        createPerformanceChart(historyList, userQuizzes, quizzesMap);
                    }
                    
                })
                .catch(error => {
                    console.error('❌ Erro ao buscar quizzes:', error);
                    // Criar cards com informações básicas mesmo sem os dados do quiz
                    userQuizzes.forEach(userQuiz => {
                        createFallbackHistoryCard(historyList, userQuiz);
                    });
                });
        })
        .catch(error => {
            console.error('❌ Erro geral ao carregar histórico:', error);
            historyList.innerHTML = `
                <div class="card">
                    <div class="card-content">
                        <div class="error-message">
                            <i class="fas fa-exclamation-circle"></i>
                            Erro ao carregar histórico. Tente novamente.
                        </div>
                    </div>
                </div>
            `;
        });
}

// Criar card de histórico individual
function createHistoryCard(container, userQuiz, quiz) {
    const historyCard = document.createElement('div');
    historyCard.className = 'card';
    
    // Determinar cor do badge baseado na performance
    let badgeClass = 'card-badge';
    let badgeText = `${userQuiz.percentage.toFixed(1)}%`;
    let performanceText = '';
    
    if (userQuiz.percentage >= 80) {
        badgeClass += ' success';
        performanceText = 'Excelente!';
    } else if (userQuiz.percentage >= 60) {
        badgeClass += ' warning';
        performanceText = 'Bom!';
    } else {
        badgeClass += ' danger';
        performanceText = 'Precisa melhorar';
    }
    
    // Calcular tempo
    const minutes = Math.floor(userQuiz.timeTaken / 60);
    const seconds = userQuiz.timeTaken % 60;
    const timeText = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    
    // Formatar data
    let dateText = 'Data não disponível';
    if (userQuiz.completedAt) {
        try {
            const date = userQuiz.completedAt.toDate ? userQuiz.completedAt.toDate() : new Date(userQuiz.completedAt);
            dateText = date.toLocaleDateString('pt-BR') + ' ' + date.toLocaleTimeString('pt-BR', {hour: '2-digit', minute: '2-digit'});
        } catch (e) {
            console.log('Erro ao formatar data:', e);
            dateText = 'Data inválida';
        }
    }
    
    historyCard.innerHTML = `
        <div class="card-header">
            <h3 class="card-title">${quiz.title}</h3>
            <div>
                <span class="${badgeClass}">${badgeText}</span>
                <span class="card-badge card-badge-secondary">${performanceText}</span>
            </div>
        </div>
        <div class="card-content">
            <p>${quiz.description}</p>
            <div class="history-details">
                <div class="detail">
                    <strong><i class="fas fa-check-circle" style="color: #28a745;"></i> Pontuação:</strong> 
                    ${userQuiz.score}/${quiz.questionsCount}
                </div>
                <div class="detail">
                    <strong><i class="fas fa-clock" style="color: #6c757d;"></i> Tempo:</strong> ${timeText}
                </div>
                <div class="detail">
                    <strong><i class="fas fa-calendar" style="color: #17a2b8;"></i> Concluído em:</strong> ${dateText}
                </div>
                <div class="detail">
                    <strong><i class="fas fa-layer-group" style="color: #6f42c1;"></i> Categoria:</strong> ${quiz.category}
                </div>
            </div>
        </div>
        <div class="card-actions">
            <button class="btn btn-primary view-details" data-quiz-id="${quiz.id}">
                <i class="fas fa-chart-bar"></i>
                <span class="btn-text">Ver Detalhes</span>
            </button>
            <button class="btn ${quiz.allowReview ? 'btn-secondary' : 'btn-danger disabled'}" 
                    data-user-quiz-id="${userQuiz.id}" data-quiz-id="${quiz.id}"
                    ${quiz.allowReview ? '' : 'disabled'}>
                <i class="fas ${quiz.allowReview ? 'fa-redo' : 'fa-lock'}"></i>
                <span class="btn-text">${quiz.allowReview ? 'Revisar' : 'Bloqueado'}</span>
            </button>
        </div>
    `;
    
    // Event listeners
    historyCard.querySelector('.view-details').addEventListener('click', function() {
        const quizId = this.getAttribute('data-quiz-id');
        showQuizResult(quizId);
    });
    
    historyCard.querySelector('.btn:last-child').addEventListener('click', function() {
        if (!this.disabled) {
            const userQuizId = this.getAttribute('data-user-quiz-id');
            const quizId = this.getAttribute('data-quiz-id');
            loadReviewData(userQuizId, quizId);
        }
    });
    
    container.appendChild(historyCard);
}

// Criar card de fallback quando o quiz não for encontrado
function createFallbackHistoryCard(container, userQuiz) {
    const historyCard = document.createElement('div');
    historyCard.className = 'card';
    
    let badgeClass = 'card-badge';
    let badgeText = `${userQuiz.percentage.toFixed(1)}%`;
    
    if (userQuiz.percentage >= 80) {
        badgeClass += ' success';
    } else if (userQuiz.percentage >= 60) {
        badgeClass += ' warning';
    } else {
        badgeClass += ' danger';
    }
    
    const minutes = Math.floor(userQuiz.timeTaken / 60);
    const seconds = userQuiz.timeTaken % 60;
    const timeText = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    
    let dateText = 'Data não disponível';
    if (userQuiz.completedAt) {
        try {
            const date = userQuiz.completedAt.toDate ? userQuiz.completedAt.toDate() : new Date(userQuiz.completedAt);
            dateText = date.toLocaleDateString('pt-BR');
        } catch (e) {
            dateText = 'Data inválida';
        }
    }
    
    historyCard.innerHTML = `
        <div class="card-header">
            <h3 class="card-title">Quiz Concluído</h3>
            <div>
                <span class="${badgeClass}">${badgeText}</span>
                <span class="card-badge card-badge-secondary">Informações Limitadas</span>
            </div>
        </div>
        <div class="card-content">
            <p>As informações completas deste quiz não estão disponíveis no momento.</p>
            <div class="history-details">
                <div class="detail">
                    <strong><i class="fas fa-check-circle" style="color: #28a745;"></i> Pontuação:</strong> 
                    ${userQuiz.score} pontos
                </div>
                <div class="detail">
                    <strong><i class="fas fa-clock" style="color: #6c757d;"></i> Tempo:</strong> ${timeText}
                </div>
                <div class="detail">
                    <strong><i class="fas fa-calendar" style="color: #17a2b8;"></i> Concluído em:</strong> ${dateText}
                </div>
            </div>
        </div>
    `;
    
    container.appendChild(historyCard);
}

// Criar gráfico de desempenho
function createPerformanceChart(container, userQuizzes, quizzesMap) {
    const chartCard = document.createElement('div');
    chartCard.className = 'card';
    chartCard.innerHTML = `
        <div class="card-header">
            <h3 class="card-title"><i class="fas fa-chart-line"></i> Meu Desempenho</h3>
        </div>
        <div class="card-content">
            <div class="chart-container">
                <canvas id="historyPerformanceChart" width="400" height="200"></canvas>
            </div>
            <div class="stats-grid" style="margin-top: 1.5rem;">
                <div class="stat-item">
                    <div class="stat-value">${userQuizzes.length}</div>
                    <div class="stat-label">Quizzes Concluídos</div>
                </div>
                <div class="stat-item">
                    <div class="stat-value">${calculateAverage(userQuizzes, 'percentage').toFixed(1)}%</div>
                    <div class="stat-label">Pontuação Média</div>
                </div>
                <div class="stat-item">
                    <div class="stat-value">${findBestPerformance(userQuizzes).toFixed(1)}%</div>
                    <div class="stat-label">Melhor Pontuação</div>
                </div>
                <div class="stat-item">
                    <div class="stat-value">${calculateTotalTime(userQuizzes)}</div>
                    <div class="stat-label">Tempo Total</div>
                </div>
            </div>
        </div>
    `;
    
    container.insertBefore(chartCard, container.firstChild);
    
    // Inicializar gráfico após o DOM ser atualizado
    setTimeout(() => {
        initializeHistoryChart(userQuizzes, quizzesMap);
    }, 100);
}

// Inicializar gráfico do histórico
function initializeHistoryChart(userQuizzes, quizzesMap) {
    const ctx = document.getElementById('historyPerformanceChart');
    if (!ctx) return;
    
    const labels = userQuizzes.map((quiz, index) => {
        const quizInfo = quizzesMap[quiz.quizId];
        return quizInfo ? quizInfo.title.substring(0, 20) + (quizInfo.title.length > 20 ? '...' : '') : `Quiz ${index + 1}`;
    });
    
    const percentages = userQuizzes.map(quiz => quiz.percentage);
    
    new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: 'Desempenho (%)',
                data: percentages,
                borderColor: '#4a6cf7',
                backgroundColor: 'rgba(74, 108, 247, 0.1)',
                borderWidth: 3,
                fill: true,
                tension: 0.4
            }]
        },
        options: {
            responsive: true,
            plugins: {
                title: {
                    display: true,
                    text: 'Evolução do Desempenho',
                    font: {
                        size: 16
                    }
                },
                legend: {
                    display: true,
                    position: 'top'
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    max: 100,
                    title: {
                        display: true,
                        text: 'Porcentagem (%)'
                    }
                },
                x: {
                    title: {
                        display: true,
                        text: 'Quizzes Realizados'
                    }
                }
            }
        }
    });
}

// Funções auxiliares para cálculos
function calculateAverage(array, field) {
    if (array.length === 0) return 0;
    const sum = array.reduce((acc, item) => acc + (item[field] || 0), 0);
    return sum / array.length;
}

function findBestPerformance(userQuizzes) {
    if (userQuizzes.length === 0) return 0;
    return Math.max(...userQuizzes.map(quiz => quiz.percentage));
}

function calculateTotalTime(userQuizzes) {
    const totalSeconds = userQuizzes.reduce((acc, quiz) => acc + (quiz.timeTaken || 0), 0);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    
    if (hours > 0) {
        return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
}

// Carregar dados para revisão
function loadReviewData(userQuizId, quizId) {
    console.log('?? Carregando dados para revis?o...');
    showLoading();

    Promise.all([
        db.collection('userQuizzes').doc(userQuizId).get(),
        db.collection('quizzes').doc(quizId).get()
    ]).then(([userQuizDoc, quizDoc]) => {
        if (!userQuizDoc.exists || !quizDoc.exists) {
            hideLoading();
            alert('Dados n?o encontrados para revis?o.');
            return;
        }

        const userQuiz = userQuizDoc.data();
        const quiz = quizDoc.data();

        if (quiz.allowReview === false) {
            hideLoading();
            alert('A revis?o de respostas está bloqueada para este quiz.');
            return;
        }

        const questionIds = Array.isArray(userQuiz.questionIds)
            ? userQuiz.questionIds.filter(Boolean)
            : [];

        if (questionIds.length === 0) {
            hideLoading();
            alert('Não foi possível recuperar as questões originais deste quiz.');
            return;
        }

        const questionFetches = questionIds.map(questionId => db.collection('questions').doc(questionId).get());

        Promise.all(questionFetches).then(questionDocs => {
            hideLoading();

            const questions = [];
            let missingQuestion = false;

            questionDocs.forEach(doc => {
                if (!doc.exists) {
                    missingQuestion = true;
                    return;
                }
                const data = doc.data();
                if (!data || !data.text) {
                    missingQuestion = true;
                    return;
                }
                questions.push({ id: doc.id, ...data });
            });

            if (missingQuestion || questions.length !== questionIds.length) {
                alert('Não foi possível recuperar todas as questões originais deste quiz.');
                return;
            }

            currentQuiz = { id: quizId, ...quiz };
            currentQuestions = questions;
            userAnswers = normalizeAnswers(userQuiz.answers || [], currentQuestions.length);
            reviewDataQuizId = quizId;
            reviewDataUserQuizId = userQuizId;

            showReviewModal();
        }).catch(error => {
            hideLoading();
            console.error('Erro ao buscar questões:', error);
            alert('Erro ao carregar questões para revisão.');
        });

    }).catch(error => {
        hideLoading();
        console.error('Erro ao carregar dados para revisão:', error);
        alert('Erro ao carregar dados para revisão.');
    });
}

// ===============================
// RANKING E RELATÓRIOS
// ===============================

// Carregar ranking geral
function loadRanking() {
    const rankingList = document.getElementById('ranking-list');
    rankingList.innerHTML = '<div class="ranking-container"><div class="ranking-item"><div class="ranking-info"><p>Carregando ranking...</p></div></div></div>';
    
    // Buscar todos os quizzes completados
    db.collection('userQuizzes')
        .where('status', '==', 'completed')
        .get()
        .then(querySnapshot => {
            const userScores = {};
            
            // Calcular pontuação total por usuário
            querySnapshot.forEach(doc => {
                const userQuiz = doc.data();
                const userId = userQuiz.userId;
                
                if (!userScores[userId]) {
                    userScores[userId] = {
                        totalScore: 0,
                        totalQuizzes: 0,
                        totalPercentage: 0,
                        userId: userId
                    };
                }
                
                userScores[userId].totalScore += userQuiz.score || 0;
                userScores[userId].totalPercentage += userQuiz.percentage || 0;
                userScores[userId].totalQuizzes += 1;
            });
            
            // Converter objeto em array e ordenar por pontuação
            const ranking = Object.values(userScores).sort((a, b) => b.totalScore - a.totalScore);
            
            // Buscar informações dos usuários
            const userIds = ranking.map(item => item.userId);
            
            if (userIds.length === 0) {
                rankingList.innerHTML = '<div class="ranking-container"><div class="ranking-item"><div class="ranking-info"><p>Nenhum resultado disponível no ranking.</p></div></div></div>';
                return;
            }
            
            // Buscar usuários em lotes para evitar limite de 10
            loadUsersInBatches(userIds, ranking, rankingList, false);
        })
        .catch(error => {
            rankingList.innerHTML = '<div class="ranking-container"><div class="ranking-item"><div class="ranking-info"><p>Erro ao carregar ranking.</p></div></div></div>';
            console.error('Erro ao carregar ranking:', error);
        });
}

// Carregar ranking geral para admin
function loadAdminRanking() {
    const rankingList = document.getElementById('admin-ranking-list');
    rankingList.innerHTML = '<div class="ranking-container"><div class="ranking-item"><div class="ranking-info"><p>Carregando ranking...</p></div></div></div>';
    
    // Buscar todos os quizzes completados
    db.collection('userQuizzes')
        .where('status', '==', 'completed')
        .get()
        .then(querySnapshot => {
            const userScores = {};
            
            // Calcular pontuação total por usuário
            querySnapshot.forEach(doc => {
                const userQuiz = doc.data();
                const userId = userQuiz.userId;
                
                if (!userScores[userId]) {
                    userScores[userId] = {
                        totalScore: 0,
                        totalQuizzes: 0,
                        totalPercentage: 0,
                        userId: userId
                    };
                }
                
                userScores[userId].totalScore += userQuiz.score || 0;
                userScores[userId].totalPercentage += userQuiz.percentage || 0;
                userScores[userId].totalQuizzes += 1;
            });
            
            // Converter objeto em array e ordenar por pontuação
            const ranking = Object.values(userScores).sort((a, b) => b.totalScore - a.totalScore);
            
            // Buscar informações dos usuários
            const userIds = ranking.map(item => item.userId);
            
            if (userIds.length === 0) {
                rankingList.innerHTML = '<div class="ranking-container"><div class="ranking-item"><div class="ranking-info"><p>Nenhum resultado disponível no ranking.</p></div></div></div>';
                return;
            }
            
            // Buscar usuários em lotes
            loadUsersInBatches(userIds, ranking, rankingList, true);
        })
        .catch(error => {
            rankingList.innerHTML = '<div class="ranking-container"><div class="ranking-item"><div class="ranking-info"><p>Erro ao carregar ranking.</p></div></div></div>';
            console.error('Erro ao carregar ranking:', error);
        });
}

// Função para carregar usuários em lotes
function loadUsersInBatches(userIds, ranking, rankingList, isAdmin = false) {
    const batchSize = 10;
    const userBatches = [];
    
    // Dividir usuários em lotes de 10
    for (let i = 0; i < userIds.length; i += batchSize) {
        userBatches.push(userIds.slice(i, i + batchSize));
    }
    
    const usersMap = {};
    let batchesProcessed = 0;
    
    // Processar cada lote
    userBatches.forEach(batch => {
        db.collection('users')
            .where(firebase.firestore.FieldPath.documentId(), 'in', batch)
            .get()
            .then(usersSnapshot => {
                usersSnapshot.forEach(doc => {
                    usersMap[doc.id] = doc.data();
                });
                
                batchesProcessed++;
                
                // Quando todos os lotes forem processados, exibir o ranking
                if (batchesProcessed === userBatches.length) {
                    displayRanking(ranking, usersMap, rankingList, isAdmin);
                }
            })
            .catch(error => {
                console.error('Erro ao buscar lote de usuários:', error);
                batchesProcessed++;
                
                if (batchesProcessed === userBatches.length) {
                    displayRanking(ranking, usersMap, rankingList, isAdmin);
                }
            });
    });
}

// Exibir ranking
function displayRanking(ranking, usersMap, rankingList, isAdmin = false) {
    // Armazenar dados em cache se for uma das listas principais
    if (rankingList.id === 'ranking-list') {
        cachedRankingData.student = { ranking, usersMap };
    } else if (rankingList.id === 'admin-ranking-list') {
        cachedRankingData.admin = { ranking, usersMap };
    }

    // Verificar se há termo de pesquisa ativo
    let filterTerm = '';
    if (rankingList.id === 'ranking-list') {
        filterTerm = document.getElementById('ranking-search').value;
    } else if (rankingList.id === 'admin-ranking-list') {
        filterTerm = document.getElementById('admin-ranking-search').value;
    }

    renderRankingList(ranking, usersMap, rankingList, isAdmin, filterTerm);
}

// Renderizar lista de ranking (com filtro opcional)
function renderRankingList(ranking, usersMap, rankingList, isAdmin, filterTerm = '') {
    rankingList.innerHTML = '';
    let visibleCount = 0;
    
    ranking.forEach((item, index) => {
        const user = usersMap[item.userId];
        if (!user) return;
        
        // Aplicar filtro se houver
        if (filterTerm && !user.name.toLowerCase().includes(filterTerm.toLowerCase())) {
            return;
        }
        visibleCount++;

        const rankingItem = document.createElement('div');
        rankingItem.className = 'ranking-item';
        
        // Destacar usuário atual
        if (item.userId === currentUser.uid) {
            rankingItem.style.background = 'rgba(74, 108, 247, 0.1)';
            rankingItem.style.borderLeft = '4px solid var(--primary-color)';
        }
        
        const avgScore = item.totalQuizzes > 0 ? (item.totalScore / item.totalQuizzes).toFixed(1) : 0;
        const avgPercentage = item.totalQuizzes > 0 ? (item.totalPercentage / item.totalQuizzes).toFixed(1) : 0;
        
        rankingItem.innerHTML = `
            <div class="ranking-position">${index + 1}</div>
            <div class="ranking-info">
                <div class="ranking-name">${user.name} ${item.userId === currentUser.uid ? '(Você)' : ''}</div>
                <div class="ranking-details">
                    ${item.totalQuizzes} quiz(s) • Média: ${avgScore} pts (${avgPercentage}%)
                    ${isAdmin ? `<br><span style="font-size: 0.8rem; color: var(--secondary-color);">${user.email}</span>` : ''}
                </div>
            </div>
            <div class="ranking-score">${item.totalScore} pts</div>
        `;
        
        rankingList.appendChild(rankingItem);
    });

    if (visibleCount === 0) {
        rankingList.innerHTML = '<div class="ranking-item"><div class="ranking-info"><p>Nenhum usuário encontrado.</p></div></div>';
    }
}

// Filtrar ranking geral
function filterRanking(term, type) {
    const data = cachedRankingData[type];
    if (!data.ranking.length) return;

    const listId = type === 'admin' ? 'admin-ranking-list' : 'ranking-list';
    const listElement = document.getElementById(listId);
    const isAdmin = type === 'admin';

    renderRankingList(data.ranking, data.usersMap, listElement, isAdmin, term);
}

// ===============================
// NOVO: RANKING POR QUIZ
// ===============================

// Carregar ranking por quiz para aluno
function loadQuizRankings() {
    const quizRankingList = document.getElementById('quiz-master-list');
    const quizSelect = document.getElementById('quiz-master-select');
    
    quizRankingList.innerHTML = '<div class="info-text"><i class="fas fa-info-circle"></i><p>Carregando quizzes...</p></div>';
    quizSelect.innerHTML = '<option value="">Carregando quizzes...</option>';
    
    // Buscar todos os quizzes ativos
    db.collection('quizzes')
        .where('status', '==', 'active')
        .get()
        .then(querySnapshot => {
            quizSelect.innerHTML = '<option value="">Selecione um quiz...</option>';
            
            if (querySnapshot.empty) {
                quizSelect.innerHTML = '<option value="">Nenhum quiz disponível</option>';
                quizRankingList.innerHTML = '<div class="info-text"><i class="fas fa-info-circle"></i><p>Nenhum quiz disponível para ver ranking.</p></div>';
                return;
            }
            
            const quizzes = [];
            querySnapshot.forEach(doc => {
                const quiz = { id: doc.id, ...doc.data() };
                quizzes.push(quiz);
                quizSelect.innerHTML += `<option value="${quiz.id}">${quiz.title}</option>`;
            });
            
            quizRankingList.innerHTML = '<div class="info-text"><i class="fas fa-info-circle"></i><p>Selecione um quiz para ver o ranking específico</p></div>';
        })
        .catch(error => {
            console.error('Erro ao carregar quizzes para ranking:', error);
            quizSelect.innerHTML = '<option value="">Erro ao carregar quizzes</option>';
            quizRankingList.innerHTML = '<div class="info-text"><i class="fas fa-info-circle"></i><p>Erro ao carregar quizzes. Tente novamente.</p></div>';
        });
}

// Carregar ranking por quiz para admin
function loadAdminQuizRankings() {
    const quizRankingList = document.getElementById('admin-quiz-master-list');
    const quizSelect = document.getElementById('admin-quiz-master-select');
    
    quizRankingList.innerHTML = '<div class="info-text"><i class="fas fa-info-circle"></i><p>Carregando quizzes...</p></div>';
    quizSelect.innerHTML = '<option value="">Carregando quizzes...</option>';
    
    // Buscar todos os quizzes
    db.collection('quizzes')
        .get()
        .then(querySnapshot => {
            quizSelect.innerHTML = '<option value="">Selecione um quiz...</option>';
            
            if (querySnapshot.empty) {
                quizSelect.innerHTML = '<option value="">Nenhum quiz disponível</option>';
                quizRankingList.innerHTML = '<div class="info-text"><i class="fas fa-info-circle"></i><p>Nenhum quiz disponível para ver ranking.</p></div>';
                return;
            }
            
            const quizzes = [];
            querySnapshot.forEach(doc => {
                const quiz = { id: doc.id, ...doc.data() };
                quizzes.push(quiz);
                const statusBadge = quiz.status === 'active' ? '✅' : '⛔';
                quizSelect.innerHTML += `<option value="${quiz.id}">${statusBadge} ${quiz.title}</option>`;
            });
            
            quizRankingList.innerHTML = '<div class="info-text"><i class="fas fa-info-circle"></i><p>Selecione um quiz para ver o ranking específico</p></div>';
        })
        .catch(error => {
            console.error('Erro ao carregar quizzes para ranking:', error);
            quizSelect.innerHTML = '<option value="">Erro ao carregar quizzes</option>';
            quizRankingList.innerHTML = '<div class="info-text"><i class="fas fa-info-circle"></i><p>Erro ao carregar quizzes. Tente novamente.</p></div>';
        });
}

// Carregar ranking específico de um quiz para aluno
function loadSpecificQuizRanking(quizId) {
    if (!quizId) return;
    
    const quizRankingList = document.getElementById('quiz-master-list');
    quizRankingList.innerHTML = '<div class="ranking-container"><div class="ranking-item"><div class="ranking-info"><p>Carregando ranking do quiz...</p></div></div></div>';
    
    // Buscar o quiz
    db.collection('quizzes').doc(quizId).get()
        .then(quizDoc => {
            if (!quizDoc.exists) {
                quizRankingList.innerHTML = '<div class="info-text"><i class="fas fa-exclamation-circle"></i><p>Quiz não encontrado.</p></div>';
                return;
            }
            
            const quiz = quizDoc.data();
            
            // Buscar todos os resultados deste quiz
            db.collection('userQuizzes')
                .where('quizId', '==', quizId)
                .where('status', '==', 'completed')
                .get()
                .then(querySnapshot => {
                    const quizResults = [];
                    
                    querySnapshot.forEach(doc => {
                        const result = doc.data();
                        quizResults.push({
                            userId: result.userId,
                            score: result.score || 0,
                            percentage: result.percentage || 0,
                            timeTaken: result.timeTaken || 0,
                            completedAt: result.completedAt || result.updatedAt
                        });
                    });
                    
                    // Ordenar por porcentagem (decrescente)
                    quizResults.sort((a, b) => b.percentage - a.percentage);
                    
                    // Buscar informações dos usuários
                    const userIds = quizResults.map(result => result.userId);
                    
                    if (userIds.length === 0) {
                        quizRankingList.innerHTML = `
                            <div class="info-text">
                                <i class="fas fa-info-circle"></i>
                                <p>Nenhum aluno completou este quiz ainda.</p>
                                <p style="font-size: 0.9rem; margin-top: 0.5rem;">Seja o primeiro a fazer o quiz "${quiz.title}"!</p>
                            </div>
                        `;
                        return;
                    }
                    
                    // Buscar usuários em lotes
                    const batchSize = 10;
                    const userBatches = [];
                    
                    for (let i = 0; i < userIds.length; i += batchSize) {
                        userBatches.push(userIds.slice(i, i + batchSize));
                    }
                    
                    const usersMap = {};
                    let batchesProcessed = 0;
                    
                    // Processar cada lote
                    userBatches.forEach(batch => {
                        db.collection('users')
                            .where(firebase.firestore.FieldPath.documentId(), 'in', batch)
                            .get()
                            .then(usersSnapshot => {
                                usersSnapshot.forEach(doc => {
                                    usersMap[doc.id] = doc.data();
                                });
                                
                                batchesProcessed++;
                                
                                // Quando todos os lotes forem processados, exibir o ranking
                                if (batchesProcessed === userBatches.length) {
                                    displayQuizRanking(quiz, quizResults, usersMap, quizRankingList, false);
                                }
                            })
                            .catch(error => {
                                console.error('Erro ao buscar lote de usuários:', error);
                                batchesProcessed++;
                                
                                if (batchesProcessed === userBatches.length) {
                                    displayQuizRanking(quiz, quizResults, usersMap, quizRankingList, false);
                                }
                            });
                    });
                })
                .catch(error => {
                    console.error('Erro ao buscar resultados do quiz:', error);
                    quizRankingList.innerHTML = '<div class="info-text"><i class="fas fa-exclamation-circle"></i><p>Erro ao carregar resultados do quiz.</p></div>';
                });
        })
        .catch(error => {
            console.error('Erro ao buscar quiz:', error);
            quizRankingList.innerHTML = '<div class="info-text"><i class="fas fa-exclamation-circle"></i><p>Erro ao carregar informações do quiz.</p></div>';
        });
}

// Carregar ranking específico de um quiz para admin
function loadAdminSpecificQuizRanking(quizId) {
    if (!quizId) return;
    
    const quizRankingList = document.getElementById('admin-quiz-master-list');
    quizRankingList.innerHTML = '<div class="ranking-container"><div class="ranking-item"><div class="ranking-info"><p>Carregando ranking do quiz...</p></div></div></div>';
    
    // Buscar o quiz
    db.collection('quizzes').doc(quizId).get()
        .then(quizDoc => {
            if (!quizDoc.exists) {
                quizRankingList.innerHTML = '<div class="info-text"><i class="fas fa-exclamation-circle"></i><p>Quiz não encontrado.</p></div>';
                return;
            }
            
            const quiz = quizDoc.data();
            
            // Buscar todos os resultados deste quiz
            db.collection('userQuizzes')
                .where('quizId', '==', quizId)
                .where('status', '==', 'completed')
                .get()
                .then(querySnapshot => {
                    const quizResults = [];
                    
                    querySnapshot.forEach(doc => {
                        const result = doc.data();
                        quizResults.push({
                            userId: result.userId,
                            score: result.score || 0,
                            percentage: result.percentage || 0,
                            timeTaken: result.timeTaken || 0,
                            completedAt: result.completedAt || result.updatedAt
                        });
                    });
                    
                    // Ordenar por porcentagem (decrescente)
                    quizResults.sort((a, b) => b.percentage - a.percentage);
                    
                    // Buscar informações dos usuários
                    const userIds = quizResults.map(result => result.userId);
                    
                    if (userIds.length === 0) {
                        quizRankingList.innerHTML = `
                            <div class="info-text">
                                <i class="fas fa-info-circle"></i>
                                <p>Nenhum aluno completou este quiz ainda.</p>
                                <p style="font-size: 0.9rem; margin-top: 0.5rem;">Quiz: "${quiz.title}"</p>
                            </div>
                        `;
                        return;
                    }
                    
                    // Buscar usuários em lotes
                    const batchSize = 10;
                    const userBatches = [];
                    
                    for (let i = 0; i < userIds.length; i += batchSize) {
                        userBatches.push(userIds.slice(i, i + batchSize));
                    }
                    
                    const usersMap = {};
                    let batchesProcessed = 0;
                    
                    // Processar cada lote
                    userBatches.forEach(batch => {
                        db.collection('users')
                            .where(firebase.firestore.FieldPath.documentId(), 'in', batch)
                            .get()
                            .then(usersSnapshot => {
                                usersSnapshot.forEach(doc => {
                                    usersMap[doc.id] = doc.data();
                                });
                                
                                batchesProcessed++;
                                
                                // Quando todos os lotes forem processados, exibir o ranking
                                if (batchesProcessed === userBatches.length) {
                                    displayQuizRanking(quiz, quizResults, usersMap, quizRankingList, true);
                                }
                            })
                            .catch(error => {
                                console.error('Erro ao buscar lote de usuários:', error);
                                batchesProcessed++;
                                
                                if (batchesProcessed === userBatches.length) {
                                    displayQuizRanking(quiz, quizResults, usersMap, quizRankingList, true);
                                }
                            });
                    });
                })
                .catch(error => {
                    console.error('Erro ao buscar resultados do quiz:', error);
                    quizRankingList.innerHTML = '<div class="info-text"><i class="fas fa-exclamation-circle"></i><p>Erro ao carregar resultados do quiz.</p></div>';
                });
        })
        .catch(error => {
            console.error('Erro ao buscar quiz:', error);
            quizRankingList.innerHTML = '<div class="info-text"><i class="fas fa-exclamation-circle"></i><p>Erro ao carregar informações do quiz.</p></div>';
        });
}

// Exibir ranking do quiz
function displayQuizRanking(quiz, quizResults, usersMap, rankingList, isAdmin = false) {
    // Armazenar dados em cache
    if (rankingList.id === 'quiz-master-list') {
        cachedQuizRankingData.student = { quiz, results: quizResults, usersMap };
    } else if (rankingList.id === 'admin-quiz-master-list') {
        cachedQuizRankingData.admin = { quiz, results: quizResults, usersMap };
    }

    // Verificar filtro
    let filterTerm = '';
    if (rankingList.id === 'quiz-master-list') {
        filterTerm = document.getElementById('quiz-master-search').value;
    } else if (rankingList.id === 'admin-quiz-master-list') {
        filterTerm = document.getElementById('admin-quiz-master-search').value;
    }

    renderQuizRankingList(quiz, quizResults, usersMap, rankingList, isAdmin, filterTerm);
}

function renderQuizRankingList(quiz, quizResults, usersMap, rankingList, isAdmin, filterTerm = '') {
    rankingList.innerHTML = '';
    
    // Adicionar cabeçalho do quiz
    const quizHeader = document.createElement('div');
    quizHeader.className = 'card';
    quizHeader.innerHTML = `
        <div class="card-header">
            <h3 class="card-title">${quiz.title}</h3>
            <div>
                <span class="card-badge">${quizResults.length} participantes</span>
                <span class="card-badge card-badge-secondary">${quiz.category || 'Geral'}</span>
            </div>
        </div>
        <div class="card-content">
            <p>${quiz.description || 'Sem descrição'}</p>
            <div class="card-meta">
                <span><i class="fas fa-clock"></i> ${quiz.time} min</span>
                <span><i class="fas fa-question-circle"></i> ${quiz.questionsCount} questões</span>
            </div>
        </div>
    `;
    rankingList.appendChild(quizHeader);
    
    // Adicionar itens do ranking
    const rankingContainer = document.createElement('div');
    rankingContainer.className = 'ranking-container';
    rankingContainer.style.marginTop = '1.5rem';
    let visibleCount = 0;
    
    quizResults.forEach((result, index) => {
        const user = usersMap[result.userId];
        if (!user) return;

        // Aplicar filtro
        if (filterTerm && !user.name.toLowerCase().includes(filterTerm.toLowerCase())) {
            return;
        }
        visibleCount++;
        
        const rankingItem = document.createElement('div');
        rankingItem.className = 'ranking-item';
        
        // Destacar usuário atual
        if (result.userId === currentUser.uid) {
            rankingItem.style.background = 'rgba(74, 108, 247, 0.1)';
            rankingItem.style.borderLeft = '4px solid var(--primary-color)';
        }
        
        // Determinar medalha
        let medal = '';
        if (index === 0) medal = '🥇';
        else if (index === 1) medal = '🥈';
        else if (index === 2) medal = '🥉';
        
        // Calcular tempo
        const minutes = Math.floor(result.timeTaken / 60);
        const seconds = result.timeTaken % 60;
        const timeText = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        
        // Formatar data
        let dateText = '';
        if (result.completedAt) {
            try {
                const date = result.completedAt.toDate ? result.completedAt.toDate() : new Date(result.completedAt);
                dateText = date.toLocaleDateString('pt-BR');
            } catch (e) {
                dateText = 'Data inválida';
            }
        }
        
        rankingItem.innerHTML = `
            <div class="ranking-position">
                ${medal} ${index + 1}
            </div>
            <div class="ranking-info">
                <div class="ranking-name">${user.name} ${result.userId === currentUser.uid ? '(Você)' : ''}</div>
                <div class="ranking-details">
                    ${result.score}/${quiz.questionsCount} questões • ${result.percentage.toFixed(1)}% • ${timeText}
                    ${isAdmin ? `<br><span style="font-size: 0.8rem; color: var(--secondary-color);">${user.email} • ${dateText}</span>` : ''}
                    ${!isAdmin && dateText ? `<br><span style="font-size: 0.8rem; color: var(--secondary-color);">${dateText}</span>` : ''}
                </div>
            </div>
            <div class="ranking-score">${result.percentage.toFixed(1)}%</div>
        `;
        
        rankingContainer.appendChild(rankingItem);
    });
    
    if (visibleCount === 0) {
        rankingContainer.innerHTML = '<div class="ranking-item"><div class="ranking-info"><p>Nenhum usuário encontrado.</p></div></div>';
    }

    rankingList.appendChild(rankingContainer);
}

// Filtrar ranking por quiz
function filterQuizRanking(term, type) {
    const data = cachedQuizRankingData[type];
    if (!data.results.length) return;

    const listId = type === 'admin' ? 'admin-quiz-master-list' : 'quiz-master-list';
    const listElement = document.getElementById(listId);
    const isAdmin = type === 'admin';

    renderQuizRankingList(data.quiz, data.results, data.usersMap, listElement, isAdmin, term);
}

// ===============================
// FUNÇÕES DO ADMINISTRADOR
// ===============================

// Carregar categorias das questões
function loadQuestionCategories() {
    return db.collection('questions')
        .get()
        .then(querySnapshot => {
            const categories = new Set(['Geral']);
            querySnapshot.forEach(doc => {
                const question = doc.data();
                if (question.category && question.category.trim() !== '') {
                    categories.add(question.category);
                }
            });
            return Array.from(categories).sort();
        });
}

// Carregar alunos disponíveis
function loadAvailableStudents() {
    const availableStudentsList = document.getElementById('available-students-list');
    availableStudentsList.innerHTML = '<p>Carregando alunos...</p>';
    
    db.collection('users')
        .where('userType', '==', 'aluno')
        .where('status', '==', 'active')
        .get()
        .then(querySnapshot => {
            availableStudents = [];
            let html = '';
            
            if (querySnapshot.empty) {
                html = '<p>Nenhum aluno cadastrado.</p>';
            } else {
                querySnapshot.forEach(doc => {
                    const student = { id: doc.id, ...doc.data() };
                    availableStudents.push(student);
                    
                    // Verificar se o aluno já está selecionado
                    const isSelected = selectedStudents.some(s => s.id === student.id);
                    
                    html += `
                        <div class="checkbox-row">
                            <input type="checkbox" id="student-${student.id}" 
                                   data-student-id="${student.id}" 
                                   data-student-name="${student.name}"
                                   ${isSelected ? 'checked' : ''}>
                            <label for="student-${student.id}">${student.name} (${student.email})</label>
                        </div>
                    `;
                });
            }
            
            availableStudentsList.innerHTML = html;
            
            // Adicionar event listeners aos checkboxes
            document.querySelectorAll('#available-students-list input[type="checkbox"]').forEach(checkbox => {
                checkbox.addEventListener('change', function() {
                    const studentId = this.getAttribute('data-student-id');
                    const studentName = this.getAttribute('data-student-name');
                    
                    if (this.checked) {
                        addStudentToSelection(studentId, studentName);
                    } else {
                        removeStudentFromSelection(studentId);
                    }
                });
            });
        })
        .catch(error => {
            console.error('Erro ao carregar alunos:', error);
            availableStudentsList.innerHTML = '<p>Erro ao carregar alunos.</p>';
        });
}

// Filtrar alunos disponíveis
function filterAvailableStudents(searchTerm) {
    const filteredStudents = availableStudents.filter(student => 
        student.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        student.email.toLowerCase().includes(searchTerm.toLowerCase())
    );
    
    let html = '';
    
    if (filteredStudents.length === 0) {
        html = '<p>Nenhum aluno encontrado.</p>';
    } else {
        filteredStudents.forEach(student => {
            const isSelected = selectedStudents.some(s => s.id === student.id);
            
            html += `
                <div class="checkbox-row">
                    <input type="checkbox" id="student-${student.id}" 
                           data-student-id="${student.id}" 
                           data-student-name="${student.name}"
                           ${isSelected ? 'checked' : ''}>
                    <label for="student-${student.id}">${student.name} (${student.email})</label>
                </div>
            `;
        });
    }
    
    document.getElementById('available-students-list').innerHTML = html;
    
    // Adicionar event listeners aos checkboxes
    document.querySelectorAll('#available-students-list input[type="checkbox"]').forEach(checkbox => {
        checkbox.addEventListener('change', function() {
            const studentId = this.getAttribute('data-student-id');
            const studentName = this.getAttribute('data-student-name');
            
            if (this.checked) {
                addStudentToSelection(studentId, studentName);
            } else {
                removeStudentFromSelection(studentId);
            }
        });
    });
}

// Adicionar aluno à seleção
function addStudentToSelection(studentId, studentName) {
    // Verificar se o aluno já está selecionado
    if (!selectedStudents.some(student => student.id === studentId)) {
        selectedStudents.push({ id: studentId, name: studentName });
        updateSelectedStudentsDisplay();
    }
}

// Remover aluno da seleção
function removeStudentFromSelection(studentId) {
    selectedStudents = selectedStudents.filter(student => student.id !== studentId);
    updateSelectedStudentsDisplay();
}

// Atualizar display dos alunos selecionados
function updateSelectedStudentsDisplay() {
    const selectedStudentsContainer = document.getElementById('selected-students');
    
    if (selectedStudents.length === 0) {
        selectedStudentsContainer.innerHTML = '<p>Nenhum aluno selecionado</p>';
    } else {
        let html = '';
        selectedStudents.forEach(student => {
            html += `
                <div class="selected-student-item">
                    <span>${student.name}</span>
                    <button class="remove-student" data-student-id="${student.id}">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
            `;
        });
        selectedStudentsContainer.innerHTML = html;
        
        // Adicionar event listeners aos botões de remover
        document.querySelectorAll('.remove-student').forEach(button => {
            button.addEventListener('click', function() {
                const studentId = this.getAttribute('data-student-id');
                removeStudentFromSelection(studentId);
                
                // Atualizar checkbox correspondente
                const checkbox = document.querySelector(`#available-students-list input[data-student-id="${studentId}"]`);
                if (checkbox) {
                    checkbox.checked = false;
                }
            });
        });
    }
}

// Carregar quizzes para administrador
function loadAdminQuizzes() {
    const quizzesList = document.getElementById('admin-quizzes-list');
    quizzesList.innerHTML = '<div class="card"><div class="card-content">Carregando quizzes...</div></div>';
    
    // Buscar todos os quizzes
    db.collection('quizzes')
        .orderBy('createdAt', 'desc')
        .get()
        .then(querySnapshot => {
            quizzesList.innerHTML = '';
            
            if (querySnapshot.empty) {
                quizzesList.innerHTML = '<div class="card"><div class="card-content">Nenhum quiz criado ainda.</div></div>';
                return;
            }
            
            querySnapshot.forEach(doc => {
                const quiz = { id: doc.id, ...doc.data() };
                const quizCard = createAdminQuizCard(quiz);
                quizzesList.appendChild(quizCard);
            });
        })
        .catch(error => {
            quizzesList.innerHTML = '<div class="card"><div class="card-content">Erro ao carregar quizzes.</div></div>';
            console.error('Erro ao carregar quizzes:', error);
        });
}

// Criar card de quiz para administrador
function createAdminQuizCard(quiz) {
    const card = document.createElement('div');
    card.className = 'card';
    
    // Determinar badge de visibilidade
    let visibilityBadge = '';
    if (quiz.visibility === 'specific' && quiz.allowedStudents) {
        const studentCount = quiz.allowedStudents.length;
        visibilityBadge = `<span class="card-badge card-badge-secondary">${studentCount} aluno(s)</span>`;
    } else {
        visibilityBadge = '<span class="card-badge card-badge-secondary">Todos os alunos</span>';
    }
    
    // Determinar badge de revisão
    let reviewBadge = '';
    if (quiz.allowReview === false) {
        reviewBadge = '<span class="card-badge danger">Revisão Bloqueada</span>';
    } else {
        reviewBadge = '<span class="card-badge success">Revisão Permitida</span>';
    }
    
    card.innerHTML = `
        <div class="card-header">
            <h3 class="card-title">${quiz.title}</h3>
            <div>
                <span class="card-badge ${quiz.status === 'active' ? '' : 'card-badge-secondary'}">${quiz.status === 'active' ? 'Ativo' : 'Inativo'}</span>
                ${visibilityBadge}
                ${reviewBadge}
            </div>
        </div>
        <div class="card-content">
            <p>${quiz.description || 'Sem descrição'}</p>
            <p><strong>Categoria:</strong> ${quiz.category || 'Geral'}</p>
            <p><strong>Questões:</strong> ${quiz.questionsCount}</p>
            <p><strong>Tempo:</strong> ${quiz.time} minutos</p>
            <p><strong>Visibilidade:</strong> ${quiz.visibility === 'specific' ? 'Alunos Específicos' : 'Todos os Alunos'}</p>
            <p><strong>Revisão de Respostas:</strong> ${quiz.allowReview === false ? 'Bloqueada' : 'Permitida'}</p>
            <p><strong>Criado em:</strong> ${quiz.createdAt ? quiz.createdAt.toDate().toLocaleDateString('pt-BR') : 'N/A'}</p>
        </div>
        <div class="card-actions">
            <button class="btn btn-primary edit-quiz" data-quiz-id="${quiz.id}">
                <i class="fas fa-edit"></i>
                <span class="btn-text">Editar</span>
            </button>
            <button class="btn btn-secondary toggle-quiz" data-quiz-id="${quiz.id}" data-status="${quiz.status}">
                <i class="fas fa-power-off"></i>
                <span class="btn-text">${quiz.status === 'active' ? 'Desativar' : 'Ativar'}</span>
            </button>
            <button class="btn btn-danger delete-quiz" data-quiz-id="${quiz.id}">
                <i class="fas fa-trash"></i>
                <span class="btn-text">Excluir</span>
            </button>
        </div>
    `;
    
    // Adicionar event listeners aos botões
    card.querySelector('.edit-quiz').addEventListener('click', () => {
        openQuizModal(quiz.id);
    });
    
    card.querySelector('.toggle-quiz').addEventListener('click', () => {
        toggleQuizStatus(quiz.id, quiz.status === 'active' ? 'inactive' : 'active');
    });
    
    card.querySelector('.delete-quiz').addEventListener('click', () => {
        deleteQuiz(quiz.id);
    });
    
    return card;
}

// Abrir modal do quiz
function openQuizModal(quizId = null) {
    editingQuizId = quizId;
    const modal = document.getElementById('quiz-modal');
    const title = document.getElementById('quiz-modal-title');
    const categorySelect = document.getElementById('quiz-category');
    
    // Resetar seleção de alunos
    selectedStudents = [];
    
    // Carregar categorias
    categorySelect.innerHTML = '<option value="">Carregando categorias...</option>';
    loadQuestionCategories().then(categories => {
        categorySelect.innerHTML = '<option value="">Selecione uma categoria</option>';
        categories.forEach(category => {
            categorySelect.innerHTML += `<option value="${category}">${category}</option>`;
        });
        
        if (quizId) {
            // Modo edição
            title.textContent = 'Editar Quiz';
            
            // Carregar dados do quiz
            db.collection('quizzes').doc(quizId).get()
                .then(doc => {
                    if (doc.exists) {
                        const quiz = doc.data();
                        
                        // Preencher campos básicos
                        document.getElementById('quiz-title').value = quiz.title;
                        document.getElementById('quiz-description').value = quiz.description || '';
                        document.getElementById('quiz-category').value = quiz.category || '';
                        document.getElementById('quiz-questions-count').value = quiz.questionsCount;
                        document.getElementById('quiz-time').value = quiz.time;
                        document.getElementById('quiz-status').value = quiz.status || 'active';
                        document.getElementById('allow-review').checked = quiz.allowReview !== false;
                        
                        // Preencher visibilidade
                        document.getElementById('quiz-visibility').value = quiz.visibility || 'all';
                        
                        // Se for visibilidade específica, carregar alunos
                        if (quiz.visibility === 'specific' && quiz.allowedStudents) {
                            document.getElementById('specific-students-container').classList.remove('hidden');
                            
                            // Carregar alunos e selecionar os que estão na lista
                            loadAvailableStudents().then(() => {
                                // Selecionar alunos permitidos
                                quiz.allowedStudents.forEach(studentId => {
                                    const student = availableStudents.find(s => s.id === studentId);
                                    if (student) {
                                        addStudentToSelection(studentId, student.name);
                                        
                                        // Marcar checkbox correspondente
                                        const checkbox = document.querySelector(`#available-students-list input[data-student-id="${studentId}"]`);
                                        if (checkbox) {
                                            checkbox.checked = true;
                                        }
                                    }
                                });
                            });
                        }
                    }
                });
        } else {
            // Modo criação
            title.textContent = 'Criar Novo Quiz';
            // Limpar campos
            document.getElementById('quiz-title').value = '';
            document.getElementById('quiz-description').value = '';
            document.getElementById('quiz-category').value = '';
            document.getElementById('quiz-questions-count').value = '';
            document.getElementById('quiz-time').value = '';
            document.getElementById('quiz-status').value = 'active';
            document.getElementById('quiz-visibility').value = 'all';
            document.getElementById('allow-review').checked = true;
            document.getElementById('specific-students-container').classList.add('hidden');
            updateSelectedStudentsDisplay();
        }
    });
    
    modal.classList.remove('hidden');
}

// Fechar modal do quiz
function closeQuizModal() {
    document.getElementById('quiz-modal').classList.add('hidden');
    editingQuizId = null;
    selectedStudents = [];
}

// Salvar quiz
function saveQuiz() {
    const title = document.getElementById('quiz-title').value;
    const description = document.getElementById('quiz-description').value;
    const category = document.getElementById('quiz-category').value;
    const questionsCount = parseInt(document.getElementById('quiz-questions-count').value);
    const time = parseInt(document.getElementById('quiz-time').value);
    const status = document.getElementById('quiz-status').value;
    const visibility = document.getElementById('quiz-visibility').value;
    const allowReview = document.getElementById('allow-review').checked;
    
    if (!title || !category || isNaN(questionsCount) || isNaN(time)) {
        alert('Por favor, preencha todos os campos obrigatórios.');
        return;
    }
    
    // Se for visibilidade específica, verificar se há alunos selecionados
    if (visibility === 'specific' && selectedStudents.length === 0) {
        alert('Por favor, selecione pelo menos um aluno para visibilidade específica.');
        return;
    }
    
    const quizData = {
        title: title,
        description: description,
        category: category,
        questionsCount: questionsCount,
        time: time,
        status: status,
        visibility: visibility,
        allowReview: allowReview,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    
    // Adicionar lista de alunos permitidos se for visibilidade específica
    if (visibility === 'specific' && selectedStudents.length > 0) {
        quizData.allowedStudents = selectedStudents.map(student => student.id);
    } else {
        // Garantir que não haja lista de alunos permitidos se for para todos
        quizData.allowedStudents = null;
    }
    
    if (editingQuizId) {
        // Atualizar quiz existente
        db.collection('quizzes').doc(editingQuizId).update(quizData)
            .then(() => {
                alert('Quiz atualizado com sucesso!');
                closeQuizModal();
                loadAdminQuizzes();
            })
            .catch(error => {
                alert('Erro ao atualizar quiz: ' + error.message);
            });
    } else {
        // Criar novo quiz
        quizData.createdAt = firebase.firestore.FieldValue.serverTimestamp();
        
        db.collection('quizzes').add(quizData)
            .then(() => {
                alert('Quiz criado com sucesso!');
                closeQuizModal();
                loadAdminQuizzes();
            })
            .catch(error => {
                alert('Erro ao criar quiz: ' + error.message);
            });
    }
}

// Alternar status do quiz
function toggleQuizStatus(quizId, newStatus) {
    db.collection('quizzes').doc(quizId).update({
        status: newStatus,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    })
    .then(() => {
        alert('Status do quiz atualizado com sucesso!');
        loadAdminQuizzes();
    })
    .catch(error => {
        alert('Erro ao atualizar status do quiz: ' + error.message);
    });
}

// Excluir quiz
function deleteQuiz(quizId) {
    if (confirm('Tem certeza que deseja excluir este quiz? Esta ação não pode ser desfeita.')) {
        db.collection('quizzes').doc(quizId).delete()
        .then(() => {
            alert('Quiz excluído com sucesso!');
            loadAdminQuizzes();
        })
        .catch(error => {
            alert('Erro ao excluir quiz: ' + error.message);
        });
    }
}

// Carregar questões para administrador
function loadAdminQuestions() {
    const questionsList = document.getElementById('admin-questions-list');
    questionsList.innerHTML = '<div class="card"><div class="card-content">Carregando questões...</div></div>';
    
    // Buscar todas as questões
    db.collection('questions')
        .orderBy('createdAt', 'desc')
        .get()
        .then(querySnapshot => {
            questionsList.innerHTML = '';
            
            if (querySnapshot.empty) {
                questionsList.innerHTML = '<div class="card"><div class="card-content">Nenhuma questão criada ainda.</div></div>';
                return;
            }
            
            querySnapshot.forEach(doc => {
                const question = { id: doc.id, ...doc.data() };
                const questionCard = createAdminQuestionCard(question);
                questionsList.appendChild(questionCard);
            });
        })
        .catch(error => {
            questionsList.innerHTML = '<div class="card"><div class="card-content">Erro ao carregar questões.</div></div>';
            console.error('Erro ao carregar questões:', error);
        });
}

// Criar card de questão para administrador
function createAdminQuestionCard(question) {
    const card = document.createElement('div');
    card.className = 'card question-card';
    
    card.innerHTML = `
        <div class="card-header">
            <h3 class="card-title">${question.text.substring(0, 80)}${question.text.length > 80 ? '...' : ''}</h3>
            <div>
                <span class="card-badge">${question.category || 'Geral'}</span>
                <button class="btn btn-icon toggle-options">
                    <i class="fas fa-chevron-down"></i>
                </button>
            </div>
        </div>
        <div class="question-options hidden">
            <div class="options-grid">
                <div class="option-item ${question.correctAnswer === 'a' ? 'correct-option' : ''}">
                    <strong>A:</strong> ${question.options?.a || 'N/A'}
                </div>
                <div class="option-item ${question.correctAnswer === 'b' ? 'correct-option' : ''}">
                    <strong>B:</strong> ${question.options?.b || 'N/A'}
                </div>
                <div class="option-item ${question.correctAnswer === 'c' ? 'correct-option' : ''}">
                    <strong>C:</strong> ${question.options?.c || 'N/A'}
                </div>
                <div class="option-item ${question.correctAnswer === 'd' ? 'correct-option' : ''}">
                    <strong>D:</strong> ${question.options?.d || 'N/A'}
                </div>
            </div>
            <p><strong>Resposta correta:</strong> <span class="correct-answer">${question.correctAnswer?.toUpperCase() || 'N/A'}</span></p>
            <p><strong>Criada em:</strong> ${question.createdAt ? question.createdAt.toDate().toLocaleDateString('pt-BR') : 'N/A'}</p>
        </div>
        <div class="card-actions">
            <button class="btn btn-primary edit-question" data-question-id="${question.id}">
                <i class="fas fa-edit"></i>
                <span class="btn-text">Editar</span>
            </button>
            <button class="btn btn-danger delete-question" data-question-id="${question.id}">
                <i class="fas fa-trash"></i>
                <span class="btn-text">Excluir</span>
            </button>
        </div>
    `;
    
    // Adicionar event listeners aos botões
    card.querySelector('.edit-question').addEventListener('click', () => {
        openQuestionModal(question.id);
    });
    
    card.querySelector('.delete-question').addEventListener('click', () => {
        deleteQuestion(question.id);
    });
    
    // Toggle para mostrar/recolher opções
    card.querySelector('.toggle-options').addEventListener('click', function() {
        const optionsContainer = card.querySelector('.question-options');
        const icon = this.querySelector('i');
        
        optionsContainer.classList.toggle('hidden');
        icon.classList.toggle('fa-chevron-down');
        icon.classList.toggle('fa-chevron-up');
    });
    
    return card;
}

// Abrir modal da questão
function openQuestionModal(questionId = null) {
    editingQuestionId = questionId;
    const modal = document.getElementById('question-modal');
    const title = document.getElementById('question-modal-title');
    
    if (questionId) {
        // Modo edição
        title.textContent = 'Editar Questão';
        
        // Carregar dados da questão
        db.collection('questions').doc(questionId).get()
            .then(doc => {
                if (doc.exists) {
                    const question = doc.data();
                    document.getElementById('question-text').value = question.text;
                    document.getElementById('question-category').value = question.category || '';
                    document.getElementById('option-a').value = question.options?.a || '';
                    document.getElementById('option-b').value = question.options?.b || '';
                    document.getElementById('option-c').value = question.options?.c || '';
                    document.getElementById('option-d').value = question.options?.d || '';
                    document.getElementById('correct-answer').value = question.correctAnswer || 'a';
                }
            });
    } else {
        // Modo criação
        title.textContent = 'Adicionar Nova Questão';
        // Limpar campos
        document.getElementById('question-text').value = '';
        document.getElementById('question-category').value = '';
        document.getElementById('option-a').value = '';
        document.getElementById('option-b').value = '';
        document.getElementById('option-c').value = '';
        document.getElementById('option-d').value = '';
        document.getElementById('correct-answer').value = 'a';
    }
    
    modal.classList.remove('hidden');
}

// Fechar modal da questão
function closeQuestionModal() {
    document.getElementById('question-modal').classList.add('hidden');
    editingQuestionId = null;
}

// Salvar questão
function saveQuestion() {
    const text = document.getElementById('question-text').value;
    const category = document.getElementById('question-category').value;
    const optionA = document.getElementById('option-a').value;
    const optionB = document.getElementById('option-b').value;
    const optionC = document.getElementById('option-c').value;
    const optionD = document.getElementById('option-d').value;
    const correctAnswer = document.getElementById('correct-answer').value;
    
    if (!text || !optionA || !optionB || !optionC || !optionD || !correctAnswer) {
        alert('Por favor, preencha todos os campos.');
        return;
    }
    
    const questionData = {
        text: text,
        category: category || 'Geral',
        options: {
            a: optionA,
            b: optionB,
            c: optionC,
            d: optionD
        },
        correctAnswer: correctAnswer,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    
    if (editingQuestionId) {
        // Atualizar questão existente
        db.collection('questions').doc(editingQuestionId).update(questionData)
            .then(() => {
                alert('Questão atualizada com sucesso!');
                closeQuestionModal();
                loadAdminQuestions();
            })
            .catch(error => {
                alert('Erro ao atualizar questão: ' + error.message);
            });
    } else {
        // Criar nova questão
        questionData.createdAt = firebase.firestore.FieldValue.serverTimestamp();
        
        db.collection('questions').add(questionData)
            .then(() => {
                alert('Questão criada com sucesso!');
                closeQuestionModal();
                loadAdminQuestions();
            })
            .catch(error => {
                alert('Erro ao criar questão: ' + error.message);
            });
    }
}

// Excluir questão
function deleteQuestion(questionId) {
    if (confirm('Tem certeza que deseja excluir esta questão? Esta ação não pode ser desfeita.')) {
        db.collection('questions').doc(questionId).delete()
        .then(() => {
            alert('Questão excluída com sucesso!');
            loadAdminQuestions();
        })
        .catch(error => {
            alert('Erro ao excluir questão: ' + error.message);
        });
    }
}

// Abrir modal de importação
function openImportModal() {
    document.getElementById('import-modal').classList.remove('hidden');
}

// Fechar modal de importação
function closeImportModal() {
    document.getElementById('import-modal').classList.add('hidden');
}

// Importar questões de JSON
function importQuestions() {
    const jsonData = document.getElementById('json-data').value;
    
    if (!jsonData) {
        alert('Por favor, cole o JSON com as questões.');
        return;
    }
    
    try {
        const questions = JSON.parse(jsonData);
        
        if (!Array.isArray(questions)) {
            alert('O JSON deve ser um array de questões.');
            return;
        }
        
        let importedCount = 0;
        let errorCount = 0;
        
        // Importar cada questão
        questions.forEach(question => {
            if (question.text && question.options && question.correctAnswer) {
                const questionData = {
                    text: question.text,
                    options: question.options,
                    correctAnswer: question.correctAnswer.toLowerCase(),
                    category: question.category || 'Geral',
                    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                };
                
                db.collection('questions').add(questionData)
                    .then(() => {
                        importedCount++;
                    })
                    .catch(error => {
                        errorCount++;
                        console.error('Erro ao importar questão:', error);
                    });
            } else {
                errorCount++;
            }
        });
        
        // Aguardar um pouco para processar todas as importações
        setTimeout(() => {
            alert(`Importação concluída!\nQuestões importadas: ${importedCount}\nErros: ${errorCount}`);
            closeImportModal();
            loadAdminQuestions();
        }, 2000);
        
    } catch (error) {
        alert('Erro ao processar JSON: ' + error.message);
    }
}

// Carregar usuários para administrador
function loadAdminUsers() {
    const usersList = document.getElementById('admin-users-list');
    usersList.innerHTML = '<div class="card"><div class="card-content">Carregando usuários...</div></div>';

    // Buscar todos os usuários e armazenar em cache para ordenação/filtragem
    db.collection('users')
        .get()
        .then(querySnapshot => {
            usersList.innerHTML = '';

            if (querySnapshot.empty) {
                usersList.innerHTML = '<div class="card"><div class="card-content">Nenhum usuário cadastrado.</div></div>';
                window.cachedAdminUsers = [];
                return;
            }

            const users = [];
            querySnapshot.forEach(doc => {
                users.push({ id: doc.id, ...doc.data() });
            });

            // Ordenar alfabeticamente por nome (case-insensitive)
            users.sort((a, b) => {
                const nameA = (a.name || '').toLowerCase();
                const nameB = (b.name || '').toLowerCase();
                if (nameA < nameB) return -1;
                if (nameA > nameB) return 1;
                return 0;
            });

            // Salvar em cache global para filtragem
            window.cachedAdminUsers = users;

            // Reaplicar filtro atual (se houver) ou renderizar todos
            const currentQuery = document.getElementById('admin-users-search')?.value || '';
            if (currentQuery.trim()) {
                filterAdminUsers(currentQuery);
            } else {
                renderAdminUsers(users);
            }
        })
        .catch(error => {
            usersList.innerHTML = '<div class="card"><div class="card-content">Erro ao carregar usuários.</div></div>';
            console.error('Erro ao carregar usuários:', error);
            window.cachedAdminUsers = [];
        });
}

// Renderiza array de usuários na lista do admin
function renderAdminUsers(users) {
    const usersList = document.getElementById('admin-users-list');
    usersList.innerHTML = '';

    if (!users || users.length === 0) {
        usersList.innerHTML = '<div class="card"><div class="card-content">Nenhum usuário encontrado.</div></div>';
        return;
    }

    // Para uma lista longa, preferimos exibir como coluna — cards permanecem, grid cuidará responsivo
    users.forEach(user => {
        const userCard = createAdminUserCard(user);
        usersList.appendChild(userCard);
    });
}

// Filtra usuários do admin por nome (input)
function filterAdminUsers(query) {
    const q = (query || '').trim().toLowerCase();
    const users = window.cachedAdminUsers || [];

    if (!q) {
        renderAdminUsers(users);
        return;
    }

    const filtered = users.filter(u => (u.name || '').toLowerCase().includes(q));
    renderAdminUsers(filtered);
}

// Criar card de usuário para administrador
function createAdminUserCard(user) {
    const card = document.createElement('div');
    card.className = 'card';
    
    const statusBadge = user.status === 'active' ? 
        '<span class="card-badge success">Ativo</span>' : 
        '<span class="card-badge danger">Inativo</span>';
    
    card.innerHTML = `
        <div class="card-header">
            <h3 class="card-title">${user.name}</h3>
            <div>
                ${statusBadge}
                <span class="card-badge ${user.userType === 'admin' ? '' : 'card-badge-secondary'}">${user.userType === 'admin' ? 'Administrador' : 'Aluno'}</span>
            </div>
        </div>
        <div class="card-content">
            <p><strong>E-mail:</strong> ${user.email}</p>
            <p><strong>Tipo:</strong> ${user.userType}</p>
            <p><strong>Status:</strong> ${user.status === 'active' ? 'Ativo' : 'Inativo'}</p>
            <p><strong>Cadastrado em:</strong> ${user.createdAt ? user.createdAt.toDate().toLocaleDateString('pt-BR') : 'N/A'}</p>
        </div>
        <div class="card-actions">
            <button class="btn btn-primary edit-user" data-user-id="${user.id}">
                <i class="fas fa-edit"></i>
                <span class="btn-text">Editar</span>
            </button>
            <button class="btn btn-secondary toggle-user" data-user-id="${user.id}" data-status="${user.status}">
                <i class="fas fa-power-off"></i>
                <span class="btn-text">${user.status === 'active' ? 'Desativar' : 'Ativar'}</span>
            </button>
            <button class="btn btn-danger delete-user" data-user-id="${user.id}">
                <i class="fas fa-trash"></i>
                <span class="btn-text">Excluir</span>
            </button>
        </div>
    `;
    
    // Adicionar event listeners aos botões
    card.querySelector('.edit-user').addEventListener('click', () => {
        openUserModal(user.id);
    });
    
    card.querySelector('.toggle-user').addEventListener('click', () => {
        toggleUserStatus(user.id, user.status === 'active' ? 'inactive' : 'active');
    });
    
    card.querySelector('.delete-user').addEventListener('click', () => {
        deleteUser(user.id);
    });
    
    return card;
}

// Abrir modal do usuário
function openUserModal(userId = null) {
    editingUserId = userId;
    const modal = document.getElementById('user-modal');
    const title = document.getElementById('user-modal-title');
    
    if (userId) {
        // Modo edição
        title.textContent = 'Editar Usuário';
        
        // Carregar dados do usuário
        db.collection('users').doc(userId).get()
            .then(doc => {
                if (doc.exists) {
                    const user = doc.data();
                    document.getElementById('user-name').value = user.name;
                    document.getElementById('user-email').value = user.email;
                    document.getElementById('user-type').value = user.userType;
                    document.getElementById('user-status').value = user.status || 'active';
                }
            });
    }
    
    modal.classList.remove('hidden');
}

// Fechar modal do usuário
function closeUserModal() {
    document.getElementById('user-modal').classList.add('hidden');
    editingUserId = null;
}

// Salvar usuário
function saveUser() {
    const name = document.getElementById('user-name').value;
    const email = document.getElementById('user-email').value;
    const userType = document.getElementById('user-type').value;
    const status = document.getElementById('user-status').value;
    
    if (!name || !email) {
        alert('Por favor, preencha todos os campos obrigatórios.');
        return;
    }
    
    const userData = {
        name: name,
        email: email,
        userType: userType,
        status: status,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    
    if (editingUserId) {
        // Atualizar usuário existente
        db.collection('users').doc(editingUserId).update(userData)
            .then(() => {
                alert('Usuário atualizado com sucesso!');
                closeUserModal();
                loadAdminUsers();
            })
            .catch(error => {
                alert('Erro ao atualizar usuário: ' + error.message);
            });
    }
}

// Alternar status do usuário
function toggleUserStatus(userId, newStatus) {
    db.collection('users').doc(userId).update({
        status: newStatus,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    })
    .then(() => {
        alert('Status do usuário atualizado com sucesso!');
        loadAdminUsers();
    })
    .catch(error => {
        alert('Erro ao atualizar status do usuário: ' + error.message);
    });
}

// Excluir usuário
function deleteUser(userId) {
    if (confirm('Tem certeza que deseja excluir este usuário? Esta ação não pode ser desfeita.')) {
        // Excluir do Firestore
        db.collection('users').doc(userId).delete()
        .then(() => {
            alert('Usuário excluído com sucesso!');
            loadAdminUsers();
        })
        .catch(error => {
            alert('Erro ao excluir usuário: ' + error.message);
        });
    }
}

// Carregar relatórios para administrador
function loadAdminReports() {
    const reportsContent = document.getElementById('admin-reports-content');
    reportsContent.innerHTML = '<div class="card"><div class="card-content">Carregando relatórios...</div></div>';
    
    // Buscar estatísticas
    Promise.all([
        db.collection('users').get(),
        db.collection('quizzes').get(),
        db.collection('questions').get(),
        db.collection('userQuizzes')
            .where('status', '==', 'completed')
            .get(),
        db.collection('users')
            .where('userType', '==', 'aluno')
            .get()
    ]).then(([usersSnapshot, quizzesSnapshot, questionsSnapshot, userQuizzesSnapshot, alunosSnapshot]) => {
        
        const totalUsers = usersSnapshot.size;
        const totalQuizzes = quizzesSnapshot.size;
        const totalQuestions = questionsSnapshot.size;
        const totalAttempts = userQuizzesSnapshot.size;
        const totalAlunos = alunosSnapshot.size;
        
        // Calcular média de pontuação
        let totalScore = 0;
        let totalPossibleScore = 0;
        userQuizzesSnapshot.forEach(doc => {
            const userQuiz = doc.data();
            totalScore += userQuiz.score || 0;
            totalPossibleScore += userQuiz.score ? (userQuiz.score / userQuiz.percentage * 100) : 0;
        });
        
        const averageScore = totalAttempts > 0 ? (totalScore / totalPossibleScore * 100).toFixed(1) : 0;
        
        reportsContent.innerHTML = `
            <div class="card">
                <div class="card-header">
                    <h3 class="card-title">Estatísticas Gerais</h3>
                </div>
                <div class="card-content">
                    <div class="stats-grid">
                        <div class="stat-item">
                            <div class="stat-value">${totalUsers}</div>
                            <div class="stat-label">Total de Usuários</div>
                        </div>
                        <div class="stat-item">
                            <div class="stat-value">${totalAlunos}</div>
                            <div class="stat-label">Alunos</div>
                        </div>
                        <div class="stat-item">
                            <div class="stat-value">${totalQuizzes}</div>
                            <div class="stat-label">Quizzes</div>
                        </div>
                        <div class="stat-item">
                            <div class="stat-value">${totalQuestions}</div>
                            <div class="stat-label">Questões</div>
                        </div>
                        <div class="stat-item">
                            <div class="stat-value">${totalAttempts}</div>
                            <div class="stat-label">Tentativas</div>
                        </div>
                        <div class="stat-item">
                            <div class="stat-value">${averageScore}%</div>
                            <div class="stat-label">Pontuação Média</div>
                        </div>
                    </div>
                </div>
            </div>
            
            <div class="card">
                <div class="card-header">
                    <h3 class="card-title">Distribuição de Desempenho</h3>
                </div>
                <div class="card-content">
                    <canvas id="performanceChart" width="400" height="200"></canvas>
                </div>
            </div>
            
            <div class="card">
                <div class="card-header">
                    <h3 class="card-title">Quizzes Mais Populares</h3>
                </div>
                <div class="card-content">
                    <div id="popular-quizzes" class="popular-list">
                        Carregando...
                    </div>
                </div>
            </div>
            
            <div class="card">
                <div class="card-header">
                    <h3 class="card-title">Top 5 Melhores Jogadores</h3>
                </div>
                <div class="card-content">
                    <div id="top-players" class="ranking-list">
                        Carregando...
                    </div>
                </div>
            </div>
            
            <div class="card">
                <div class="card-header">
                    <h3 class="card-title">Ranking Geral Completo</h3>
                </div>
                <div class="card-content">
                    <div id="full-ranking" class="ranking-list">
                        Carregando...
                    </div>
                </div>
            </div>
        `;
        
        loadPerformanceChart();
        loadPopularQuizzes();
        loadTopPlayers();
        loadFullRanking();
        
    }).catch(error => {
        reportsContent.innerHTML = '<div class="card"><div class="card-content">Erro ao carregar relatórios.</div></div>';
        console.error('Erro ao carregar relatórios:', error);
    });
}

// Carregar gráfico de desempenho
function loadPerformanceChart() {
    db.collection('userQuizzes')
        .where('status', '==', 'completed')
        .get()
        .then(querySnapshot => {
            const performanceRanges = {
                '0-20': 0,
                '21-40': 0,
                '41-60': 0,
                '61-80': 0,
                '81-100': 0
            };
            
            querySnapshot.forEach(doc => {
                const userQuiz = doc.data();
                const percentage = userQuiz.percentage || 0;
                
                if (percentage <= 20) performanceRanges['0-20']++;
                else if (percentage <= 40) performanceRanges['21-40']++;
                else if (percentage <= 60) performanceRanges['41-60']++;
                else if (percentage <= 80) performanceRanges['61-80']++;
                else performanceRanges['81-100']++;
            });
            
            const ctx = document.getElementById('performanceChart').getContext('2d');
            new Chart(ctx, {
                type: 'bar',
                data: {
                    labels: ['0-20%', '21-40%', '41-60%', '61-80%', '81-100%'],
                    datasets: [{
                        label: 'Número de Tentativas',
                        data: [
                            performanceRanges['0-20'],
                            performanceRanges['21-40'],
                            performanceRanges['41-60'],
                            performanceRanges['61-80'],
                            performanceRanges['81-100']
                        ],
                        backgroundColor: [
                            '#dc3545',
                            '#ffc107',
                            '#17a2b8',
                            '#28a745',
                            '#007bff'
                        ]
                    }]
                },
                options: {
                    responsive: true,
                    scales: {
                        y: {
                            beginAtZero: true,
                            title: {
                                display: true,
                                text: 'Número de Tentativas'
                            }
                        },
                        x: {
                            title: {
                                display: true,
                                text: 'Faixa de Pontuação'
                            }
                        }
                    }
                }
            });
        })
        .catch(error => {
            console.error('Erro ao carregar gráfico:', error);
        });
}

// Carregar quizzes populares
function loadPopularQuizzes() {
    const popularQuizzesElement = document.getElementById('popular-quizzes');
    
    db.collection('userQuizzes')
        .where('status', '==', 'completed')
        .get()
        .then(userQuizzesSnapshot => {
            const quizAttempts = {};
            
            // Contar tentativas por quiz
            userQuizzesSnapshot.forEach(doc => {
                const userQuiz = doc.data();
                const quizId = userQuiz.quizId;
                
                if (!quizAttempts[quizId]) {
                    quizAttempts[quizId] = {
                        attempts: 0,
                        totalScore: 0,
                        quizId: quizId
                    };
                }
                
                quizAttempts[quizId].attempts++;
                quizAttempts[quizId].totalScore += userQuiz.score || 0;
            });
            
            // Buscar informações dos quizzes
            const quizIds = Object.keys(quizAttempts);
            
            if (quizIds.length === 0) {
                popularQuizzesElement.innerHTML = '<p>Nenhum quiz foi realizado ainda.</p>';
                return;
            }
            
            db.collection('quizzes')
                .where(firebase.firestore.FieldPath.documentId(), 'in', quizIds)
                .get()
                .then(quizzesSnapshot => {
                    const quizzesMap = {};
                    quizzesSnapshot.forEach(doc => {
                        quizzesMap[doc.id] = doc.data();
                    });
                    
                    // Criar lista ordenada por tentativas
                    const popularList = Object.values(quizAttempts)
                        .sort((a, b) => b.attempts - a.attempts)
                        .slice(0, 5);
                    
                    let html = '';
                    popularList.forEach((item, index) => {
                        const quiz = quizzesMap[item.quizId];
                        if (quiz) {
                            const avgScore = item.attempts > 0 ? (item.totalScore / item.attempts).toFixed(1) : 0;
                            html += `
                                <div class="popular-item">
                                    <div class="popular-rank">${index + 1}</div>
                                    <div class="popular-info">
                                        <div class="popular-name">${quiz.title}</div>
                                        <div class="popular-details">
                                            ${item.attempts} tentativas • Média: ${avgScore} pts
                                        </div>
                                    </div>
                                </div>
                            `;
                        }
                    });
                    
                    popularQuizzesElement.innerHTML = html || '<p>Nenhum dado disponível.</p>';
                });
        })
        .catch(error => {
            popularQuizzesElement.innerHTML = '<p>Erro ao carregar dados.</p>';
            console.error('Erro ao carregar quizzes populares:', error);
        });
}

// Carregar melhores jogadores
function loadTopPlayers() {
    const topPlayersElement = document.getElementById('top-players');
    
    db.collection('userQuizzes')
        .where('status', '==', 'completed')
        .get()
        .then(userQuizzesSnapshot => {
            const userScores = {};
            
            // Calcular pontuação total por usuário
            userQuizzesSnapshot.forEach(doc => {
                const userQuiz = doc.data();
                const userId = userQuiz.userId;
                
                if (!userScores[userId]) {
                    userScores[userId] = {
                        totalScore: 0,
                        totalQuizzes: 0,
                        totalPercentage: 0,
                        userId: userId
                    };
                }
                
                userScores[userId].totalScore += userQuiz.score || 0;
                userScores[userId].totalPercentage += userQuiz.percentage || 0;
                userScores[userId].totalQuizzes += 1;
            });
            
            // Converter para array e ordenar
            const topPlayers = Object.values(userScores)
                .sort((a, b) => b.totalScore - a.totalScore)
                .slice(0, 5);
            
            // Buscar informações dos usuários
            const userIds = topPlayers.map(player => player.userId);
            
            if (userIds.length === 0) {
                topPlayersElement.innerHTML = '<p>Nenhum jogador com pontuação ainda.</p>';
                return;
            }
            
            loadUsersInBatches(userIds, topPlayers, topPlayersElement, true);
        })
        .catch(error => {
            topPlayersElement.innerHTML = '<p>Erro ao carregar dados.</p>';
            console.error('Erro ao carregar melhores jogadores:', error);
        });
}

// Carregar ranking completo
function loadFullRanking() {
    const fullRankingElement = document.getElementById('full-ranking');
    fullRankingElement.innerHTML = '<div class="ranking-list">Carregando ranking completo...</div>';
    
    console.log('🔄 Iniciando carregamento do ranking completo...');
    
    db.collection('userQuizzes')
        .where('status', '==', 'completed')
        .get()
        .then(userQuizzesSnapshot => {
            console.log('✅ Quizzes completados encontrados:', userQuizzesSnapshot.size);
            
            const userScores = {};
            
            // Calcular pontuação total por usuário
            userQuizzesSnapshot.forEach(doc => {
                const userQuiz = doc.data();
                const userId = userQuiz.userId;
                
                if (!userScores[userId]) {
                    userScores[userId] = {
                        totalScore: 0,
                        totalQuizzes: 0,
                        totalPercentage: 0,
                        userId: userId
                    };
                }
                
                userScores[userId].totalScore += userQuiz.score || 0;
                userScores[userId].totalPercentage += userQuiz.percentage || 0;
                userScores[userId].totalQuizzes += 1;
            });
            
            // Converter para array e ordenar
            const fullRanking = Object.values(userScores)
                .sort((a, b) => b.totalScore - a.totalScore);
            
            console.log('👥 Usuários no ranking:', fullRanking.length);
            
            // Buscar informações dos usuários
            const userIds = fullRanking.map(player => player.userId);
            
            if (userIds.length === 0) {
                fullRankingElement.innerHTML = '<p>Nenhum jogador com pontuação ainda.</p>';
                return;
            }
            
            loadUsersInBatchesForFullRanking(userIds, fullRanking, fullRankingElement);
        })
        .catch(error => {
            console.error('❌ Erro ao carregar ranking completo:', error);
            fullRankingElement.innerHTML = '<p>Erro ao carregar dados do ranking.</p>';
        });
}

// Nova função para carregar usuários em lotes para o ranking completo
function loadUsersInBatchesForFullRanking(userIds, fullRanking, fullRankingElement) {
    const batchSize = 10;
    const userBatches = [];
    
    // Dividir usuários em lotes de 10
    for (let i = 0; i < userIds.length; i += batchSize) {
        userBatches.push(userIds.slice(i, i + batchSize));
    }
    
    const usersMap = {};
    let batchesProcessed = 0;
    const totalBatches = userBatches.length;
    
    console.log(`📦 Processando ${totalBatches} lotes de usuários...`);
    
    // Processar cada lote
    userBatches.forEach((batch, batchIndex) => {
        db.collection('users')
            .where(firebase.firestore.FieldPath.documentId(), 'in', batch)
            .get()
            .then(usersSnapshot => {
                usersSnapshot.forEach(doc => {
                    usersMap[doc.id] = doc.data();
                });
                
                batchesProcessed++;
                console.log(`✅ Lote ${batchIndex + 1}/${totalBatches} processado`);
                
                // Atualizar progresso
                const progress = Math.round((batchesProcessed / totalBatches) * 100);
                fullRankingElement.innerHTML = `<div class="ranking-list">Carregando ranking... ${progress}%</div>`;
                
                // Quando todos os lotes forem processados, exibir o ranking completo
                if (batchesProcessed === totalBatches) {
                    console.log('🎉 Todos os lotes processados, exibindo ranking...');
                    displayFullRanking(fullRanking, usersMap, fullRankingElement);
                }
            })
            .catch(error => {
                console.error(`❌ Erro ao buscar lote ${batchIndex + 1} de usuários:`, error);
                batchesProcessed++;
                
                if (batchesProcessed === totalBatches) {
                    displayFullRanking(fullRanking, usersMap, fullRankingElement);
                }
            });
    });
}

// Exibir ranking completo
function displayFullRanking(fullRanking, usersMap, fullRankingElement) {
    let html = '';
    
    fullRanking.forEach((player, index) => {
        const user = usersMap[player.userId];
        if (user) {
            const avgScore = player.totalQuizzes > 0 ? (player.totalScore / player.totalQuizzes).toFixed(1) : 0;
            const avgPercentage = player.totalQuizzes > 0 ? (player.totalPercentage / player.totalQuizzes).toFixed(1) : 0;
            
            // Destacar usuário atual
            const isCurrentUser = player.userId === currentUser.uid;
            const highlightClass = isCurrentUser ? 'ranking-item-highlight' : '';
            
            html += `
                <div class="ranking-item ${highlightClass}">
                    <div class="ranking-position">${index + 1}</div>
                    <div class="ranking-info">
                        <div class="ranking-name">${user.name} ${isCurrentUser ? '(Você)' : ''}</div>
                        <div class="ranking-details">
                            ${player.totalQuizzes} quiz(s) • Média: ${avgScore} pts (${avgPercentage}%)
                            <br><span style="font-size: 0.8rem; color: var(--secondary-color);">${user.email}</span>
                        </div>
                    </div>
                    <div class="ranking-score">${player.totalScore} pts</div>
                </div>
            `;
        }
    });
    
    if (html === '') {
        html = '<p>Nenhum dado disponível para exibir.</p>';
    }
    
    fullRankingElement.innerHTML = html;
    
    console.log('✅ Ranking completo carregado com sucesso!');
}
