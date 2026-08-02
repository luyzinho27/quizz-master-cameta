<<<<<<< HEAD
// Configuração do Firebase
function resolveFirebaseConfig() {
    const candidate = window.QUIZZ_MASTER_CAMETA_FIREBASE_CONFIG || window.QUIZ_MASTER_FIREBASE_CONFIG;
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
let editingRoomId = null;
let editingTeacherQuizId = null;
let editingTeacherUserId = null;
let teacherRoomsCache = [];
let currentUserPassword = null;

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
let adminUsersCache = [];
let teacherStudentsCache = [];
let teacherQuizzesCache = [];
let teacherUsersCache = [];

// Elementos da DOM
const authContainer = document.getElementById('auth-container');
const studentDashboard = document.getElementById('student-dashboard');
const adminDashboard = document.getElementById('admin-dashboard');
const teacherDashboard = document.getElementById('teacher-dashboard');
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

function setCurrentUserPassword(password) {
    currentUserPassword = password || null;
}

function clearCurrentUserPassword() {
    currentUserPassword = null;
}

function createUserAccount({ name, email, password, userType, status = 'active', extraData = {} }) {
    const previousAuthUser = auth.currentUser;
    const previousPassword = previousAuthUser && previousAuthUser.email ? currentUserPassword : null;
    const restorePreviousAuth = Boolean(previousAuthUser && previousAuthUser.email && previousPassword && previousAuthUser.email !== email);

    return auth.createUserWithEmailAndPassword(email, password)
        .then(async (userCredential) => {
            const createdUser = userCredential.user;
            const userData = {
                name,
                email,
                userType: userType || 'aluno',
                status,
                createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
                roomIds: [],
                ...extraData
            };

            await db.collection('users').doc(createdUser.uid).set(userData);

            if (restorePreviousAuth) {
                await auth.signOut();
                await auth.signInWithEmailAndPassword(previousAuthUser.email, previousPassword);
            }

            return { uid: createdUser.uid, userData };
        });
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
// Removed duplicate initEventListeners definition. The single implementation
// is defined later in the file.

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

    // Modais do professor
    document.getElementById('close-room-modal')?.addEventListener('click', closeRoomModal);
    document.getElementById('cancel-room')?.addEventListener('click', closeRoomModal);
    document.getElementById('save-room')?.addEventListener('click', saveRoom);
    document.getElementById('close-teacher-quiz-modal')?.addEventListener('click', closeTeacherQuizModal);
    document.getElementById('cancel-teacher-quiz')?.addEventListener('click', closeTeacherQuizModal);
    document.getElementById('save-teacher-quiz')?.addEventListener('click', saveTeacherQuiz);
    document.getElementById('close-teacher-user-modal')?.addEventListener('click', closeTeacherUserModal);
    document.getElementById('cancel-teacher-user')?.addEventListener('click', closeTeacherUserModal);
    document.getElementById('save-teacher-user')?.addEventListener('click', saveTeacherUser);
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

// Removed duplicate switchTeacherTab definition. The single implementation
// is defined later in the file.

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
    document.getElementById('teacher-logout')?.addEventListener('click', logout);
    
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
    document.getElementById('create-user-btn')?.addEventListener('click', () => openUserModal());

    // Botões do professor
    document.getElementById('create-room-btn')?.addEventListener('click', () => openRoomModal());
    document.getElementById('teacher-create-quiz-btn')?.addEventListener('click', () => openTeacherQuizModal());
    document.getElementById('create-student-btn')?.addEventListener('click', () => openTeacherUserModal());
    
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

    // Modais do professor
    document.getElementById('close-room-modal')?.addEventListener('click', closeRoomModal);
    document.getElementById('cancel-room')?.addEventListener('click', closeRoomModal);
    document.getElementById('save-room')?.addEventListener('click', saveRoom);
    document.getElementById('close-teacher-quiz-modal')?.addEventListener('click', closeTeacherQuizModal);
    document.getElementById('cancel-teacher-quiz')?.addEventListener('click', closeTeacherQuizModal);
    document.getElementById('save-teacher-quiz')?.addEventListener('click', saveTeacherQuiz);
    document.getElementById('close-teacher-user-modal')?.addEventListener('click', closeTeacherUserModal);
    document.getElementById('cancel-teacher-user')?.addEventListener('click', closeTeacherUserModal);
    document.getElementById('save-teacher-user')?.addEventListener('click', saveTeacherUser);
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

function switchTeacherTab(tabId, sectionId) {
    const tabs = document.querySelectorAll('#teacher-dashboard .dashboard-header .tab');
    const sections = document.querySelectorAll('#teacher-dashboard .dashboard-content .section');

    tabs.forEach(tab => tab.classList.remove('active'));
    sections.forEach(section => section.classList.remove('active'));

    document.getElementById(tabId).classList.add('active');
    document.getElementById(sectionId).classList.add('active');
}

// Funções de loading
function showLoading() {
    loading.classList.remove('hidden');
}

function hideLoading() {
    loading.classList.add('hidden');
}

function setCurrentUserPassword(password) {
    currentUserPassword = password || null;
}

function clearCurrentUserPassword() {
    currentUserPassword = null;
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
    document.getElementById('teacher-logout')?.addEventListener('click', logout);
    
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
    document.getElementById('create-user-btn')?.addEventListener('click', () => openUserModal());

    // Botões do professor
    document.getElementById('create-room-btn')?.addEventListener('click', () => openRoomModal());
    document.getElementById('teacher-create-quiz-btn')?.addEventListener('click', () => openTeacherQuizModal());
    document.getElementById('create-student-btn')?.addEventListener('click', () => openTeacherUserModal());
    
    // Inicializar página sobre se existir
    if (document.getElementById('about-section')) {
        initAboutPage();
    }

    // Inicializar listeners de pesquisa
    initSearchListeners();

    window.addEventListener('beforeunload', handleQuizBeforeUnload);
    window.addEventListener('pagehide', handleQuizBeforeUnload);
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

    // Modais do professor
    document.getElementById('close-room-modal')?.addEventListener('click', closeRoomModal);
    document.getElementById('cancel-room')?.addEventListener('click', closeRoomModal);
    document.getElementById('save-room')?.addEventListener('click', saveRoom);
    document.getElementById('close-teacher-quiz-modal')?.addEventListener('click', closeTeacherQuizModal);
    document.getElementById('cancel-teacher-quiz')?.addEventListener('click', closeTeacherQuizModal);
    document.getElementById('save-teacher-quiz')?.addEventListener('click', saveTeacherQuiz);
    document.getElementById('close-teacher-user-modal')?.addEventListener('click', closeTeacherUserModal);
    document.getElementById('cancel-teacher-user')?.addEventListener('click', closeTeacherUserModal);
    document.getElementById('save-teacher-user')?.addEventListener('click', saveTeacherUser);
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

function switchTeacherTab(tabId, sectionId) {
    const tabs = document.querySelectorAll('#teacher-dashboard .dashboard-header .tab');
    const sections = document.querySelectorAll('#teacher-dashboard .dashboard-content .section');

    tabs.forEach(tab => tab.classList.remove('active'));
    sections.forEach(section => section.classList.remove('active'));

    document.getElementById(tabId).classList.add('active');
    document.getElementById(sectionId).classList.add('active');
}

// Funções de loading
function showLoading() {
    loading.classList.remove('hidden');
}

function hideLoading() {
    loading.classList.add('hidden');
}

function setCurrentUserPassword(password) {
    currentUserPassword = password || null;
}

function clearCurrentUserPassword() {
    currentUserPassword = null;
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
            };
            return db.collection('users').doc(user.uid).set(userData)
                .then(() => {
                    quizResult.classList.remove('hidden');
                    return userData;
                });
        })
        .catch(error => {
            console.error('Erro ao buscar resultado salvo:', error);
            // Em caso de erro, voltar para o dashboard
            showDashboard();
        });
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
        
        rankingList.appendChild(rankingItem);
    });
    
    if (visibleCount === 0) {
        rankingList.innerHTML = '<div class="ranking-item"><div class="ranking-info"><p>Nenhum usuário encontrado.</p></div></div>';
    }
}

// Filtrar ranking por quiz
function filterQuizRanking(term, type) {
    const data = cachedQuizRankingData[type];
    if (!data.results.length) return;

    const listId = type === 'admin' ? 'admin-quiz-master-list' : 'quiz-master-list';
    const listElement = document.getElementById(listId);
    const isAdmin = type === 'admin';

    renderQuizRankingList(data.quiz, data.results, data.usersMap, listElement, isAdmin, term);
=======
// Configuração do Firebase
function resolveFirebaseConfig() {
    const candidate = window.QUIZZ_MASTER_CAMETA_FIREBASE_CONFIG || window.QUIZ_MASTER_FIREBASE_CONFIG;
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

// Inicializar Firebase.
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
let editingRoomId = null;
let editingTeacherQuizId = null;
let editingTeacherUserId = null;
let teacherRoomsCache = [];
let currentUserPassword = null;

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
let adminUsersCache = [];
let teacherStudentsCache = [];
let teacherQuizzesCache = [];
let teacherUsersCache = [];

// Elementos da DOM
const authContainer = document.getElementById('auth-container');
const studentDashboard = document.getElementById('student-dashboard');
const adminDashboard = document.getElementById('admin-dashboard');
const teacherDashboard = document.getElementById('teacher-dashboard');
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

function setCurrentUserPassword(password) {
    currentUserPassword = password || null;
}

function clearCurrentUserPassword() {
    currentUserPassword = null;
}

function createUserAccount({ name, email, password, userType, status = 'active', extraData = {} }) {
    const previousAuthUser = auth.currentUser;
    const previousPassword = previousAuthUser && previousAuthUser.email ? currentUserPassword : null;
    const restorePreviousAuth = Boolean(previousAuthUser && previousAuthUser.email && previousPassword && previousAuthUser.email !== email);

    return auth.createUserWithEmailAndPassword(email, password)
        .then(async (userCredential) => {
            const createdUser = userCredential.user;
            const userData = {
                name,
                email,
                userType: userType || 'aluno',
                status,
                createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
                roomIds: [],
                ...extraData
            };

            await db.collection('users').doc(createdUser.uid).set(userData);

            if (restorePreviousAuth) {
                await auth.signOut();
                await auth.signInWithEmailAndPassword(previousAuthUser.email, previousPassword);
            }

            return { uid: createdUser.uid, userData };
        });
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
// Removed duplicate initEventListeners definition. The single implementation
// is defined later in the file.

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

    // Modais do professor
    document.getElementById('close-room-modal')?.addEventListener('click', closeRoomModal);
    document.getElementById('cancel-room')?.addEventListener('click', closeRoomModal);
    document.getElementById('save-room')?.addEventListener('click', saveRoom);
    document.getElementById('close-teacher-quiz-modal')?.addEventListener('click', closeTeacherQuizModal);
    document.getElementById('cancel-teacher-quiz')?.addEventListener('click', closeTeacherQuizModal);
    document.getElementById('save-teacher-quiz')?.addEventListener('click', saveTeacherQuiz);
    document.getElementById('close-teacher-user-modal')?.addEventListener('click', closeTeacherUserModal);
    document.getElementById('cancel-teacher-user')?.addEventListener('click', closeTeacherUserModal);
    document.getElementById('save-teacher-user')?.addEventListener('click', saveTeacherUser);
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

// Removed duplicate switchTeacherTab definition. The single implementation
// is defined later in the file.

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
    document.getElementById('teacher-logout')?.addEventListener('click', logout);
    
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
    document.getElementById('create-user-btn')?.addEventListener('click', () => openUserModal());

    // Botões do professor
    document.getElementById('create-room-btn')?.addEventListener('click', () => openRoomModal());
    document.getElementById('teacher-create-quiz-btn')?.addEventListener('click', () => openTeacherQuizModal());
    document.getElementById('create-student-btn')?.addEventListener('click', () => openTeacherUserModal());
    
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

    // Modais do professor
    document.getElementById('close-room-modal')?.addEventListener('click', closeRoomModal);
    document.getElementById('cancel-room')?.addEventListener('click', closeRoomModal);
    document.getElementById('save-room')?.addEventListener('click', saveRoom);
    document.getElementById('close-teacher-quiz-modal')?.addEventListener('click', closeTeacherQuizModal);
    document.getElementById('cancel-teacher-quiz')?.addEventListener('click', closeTeacherQuizModal);
    document.getElementById('save-teacher-quiz')?.addEventListener('click', saveTeacherQuiz);
    document.getElementById('close-teacher-user-modal')?.addEventListener('click', closeTeacherUserModal);
    document.getElementById('cancel-teacher-user')?.addEventListener('click', closeTeacherUserModal);
    document.getElementById('save-teacher-user')?.addEventListener('click', saveTeacherUser);
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

function switchTeacherTab(tabId, sectionId) {
    const tabs = document.querySelectorAll('#teacher-dashboard .dashboard-header .tab');
    const sections = document.querySelectorAll('#teacher-dashboard .dashboard-content .section');

    tabs.forEach(tab => tab.classList.remove('active'));
    sections.forEach(section => section.classList.remove('active'));

    document.getElementById(tabId).classList.add('active');
    document.getElementById(sectionId).classList.add('active');
}

// Funções de loading
function showLoading() {
    loading.classList.remove('hidden');
}

function hideLoading() {
    loading.classList.add('hidden');
}

function setCurrentUserPassword(password) {
    currentUserPassword = password || null;
}

function clearCurrentUserPassword() {
    currentUserPassword = null;
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
    document.getElementById('teacher-logout')?.addEventListener('click', logout);
    
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
    document.getElementById('create-user-btn')?.addEventListener('click', () => openUserModal());

    // Botões do professor
    document.getElementById('create-room-btn')?.addEventListener('click', () => openRoomModal());
    document.getElementById('teacher-create-quiz-btn')?.addEventListener('click', () => openTeacherQuizModal());
    document.getElementById('create-student-btn')?.addEventListener('click', () => openTeacherUserModal());
    
    // Inicializar página sobre se existir
    if (document.getElementById('about-section')) {
        initAboutPage();
    }

    // Inicializar listeners de pesquisa
    initSearchListeners();

    window.addEventListener('beforeunload', handleQuizBeforeUnload);
    window.addEventListener('pagehide', handleQuizBeforeUnload);
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

    // Modais do professor
    document.getElementById('close-room-modal')?.addEventListener('click', closeRoomModal);
    document.getElementById('cancel-room')?.addEventListener('click', closeRoomModal);
    document.getElementById('save-room')?.addEventListener('click', saveRoom);
    document.getElementById('close-teacher-quiz-modal')?.addEventListener('click', closeTeacherQuizModal);
    document.getElementById('cancel-teacher-quiz')?.addEventListener('click', closeTeacherQuizModal);
    document.getElementById('save-teacher-quiz')?.addEventListener('click', saveTeacherQuiz);
    document.getElementById('close-teacher-user-modal')?.addEventListener('click', closeTeacherUserModal);
    document.getElementById('cancel-teacher-user')?.addEventListener('click', closeTeacherUserModal);
    document.getElementById('save-teacher-user')?.addEventListener('click', saveTeacherUser);
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

function switchTeacherTab(tabId, sectionId) {
    const tabs = document.querySelectorAll('#teacher-dashboard .dashboard-header .tab');
    const sections = document.querySelectorAll('#teacher-dashboard .dashboard-content .section');

    tabs.forEach(tab => tab.classList.remove('active'));
    sections.forEach(section => section.classList.remove('active'));

    document.getElementById(tabId).classList.add('active');
    document.getElementById(sectionId).classList.add('active');
}

// Funções de loading
function showLoading() {
    loading.classList.remove('hidden');
}

function hideLoading() {
    loading.classList.add('hidden');
}

function setCurrentUserPassword(password) {
    currentUserPassword = password || null;
}

function clearCurrentUserPassword() {
    currentUserPassword = null;
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
            };
            return db.collection('users').doc(user.uid).set(userData)
                .then(() => {
                    quizResult.classList.remove('hidden');
                    return userData;
                });
        })
        .catch(error => {
            console.error('Erro ao buscar resultado salvo:', error);
            // Em caso de erro, voltar para o dashboard
            showDashboard();
        });
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
        
        rankingList.appendChild(rankingItem);
    });
    
    if (visibleCount === 0) {
        rankingList.innerHTML = '<div class="ranking-item"><div class="ranking-info"><p>Nenhum usuário encontrado.</p></div></div>';
    }
}

// Filtrar ranking por quiz
function filterQuizRanking(term, type) {
    const data = cachedQuizRankingData[type];
    if (!data.results.length) return;

    const listId = type === 'admin' ? 'admin-quiz-master-list' : 'quiz-master-list';
    const listElement = document.getElementById(listId);
    const isAdmin = type === 'admin';

    renderQuizRankingList(data.quiz, data.results, data.usersMap, listElement, isAdmin, term);
>>>>>>> 0392b91 (Atualização do QuizMaster)
}