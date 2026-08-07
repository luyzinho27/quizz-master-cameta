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
const authPersistenceReady = auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL)
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
                // Verificar se o usuário está inativo
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


function initAuth() {
    console.log('Iniciando autenticação...');
}
// End of initAuth function
// The following code initializes UI elements and event listeners
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
                if (error && error.code === 'auth/operation-not-allowed') {
                    showError('login-error', 'Login com e-mail e senha não habilitado no projeto Firebase. Ative-o no console Firebase, na aba "Authentication" > "Sign-in method".');
                } else {
                    showError('login-error', getAuthErrorMessage(error));
                }
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


function hideDashboard() {
    // Oculta todas as seções de dashboard e mostra o container de autenticação
    authContainer.classList.add('hidden');
    studentDashboard.classList.add('hidden');
    adminDashboard.classList.add('hidden');
    teacherDashboard.classList.add('hidden');
    quizContainer.classList.add('hidden');
    quizResult.classList.add('hidden');
}

function showAuth() {
    hideDashboard();
    authContainer.classList.remove('hidden');
}

// Exibe o dashboard apropriado com base no tipo de usuário
function showDashboard() {
    hideDashboard();
    if (!currentUser) {
        showAuth();
        return;
    }
    const type = currentUser.userType;
    if (type === 'aluno') {
        studentDashboard.classList.remove('hidden');
    } else if (type === 'admin') {
        adminDashboard.classList.remove('hidden');
    } else if (type === 'professor' || type === 'prof') {
        teacherDashboard.classList.remove('hidden');
    } else {
        // Caso o tipo não seja reconhecido, exibe a tela de autenticação
        showAuth();
    }
}

// Função para confirmar e sair do quiz
function confirmExitQuiz() {
    // Se não houver quiz ativo, apenas exibe o dashboard
    if (!currentQuiz) {
        showDashboard();
        return;
    }
    const confirmMsg = 'Tem certeza que deseja sair do quiz? Todas as respostas não salvas serão perdidas.';
    if (!confirm(confirmMsg)) {
        return;
    }
    // Limpar estado local do quiz
    if (currentUser && currentQuiz) {
        clearQuizStateLocal(currentUser.uid, currentQuiz.id);
    }
    // Resetar variáveis de estado
    currentQuiz = null;
    currentQuestions = [];
    currentQuestionIndex = 0;
    userAnswers = [];
    quizTimer = null;
    timeRemaining = 0;
    totalTime = 0;
    quizActive = false;
    // Exibir dashboard principal
    showDashboard();
}

// Função de logout
function logout() {
    auth.signOut()
        .then(() => {
            hideDashboard();
            showAuth();
        })
        .catch(error => {
            console.error('Erro ao sair:', error);
            showError('login-error', getAuthErrorMessage(error));
        });
}

// Expor funções que podem ser chamadas a partir de atributos HTML
window.logout = logout;
window.showAuth = showAuth;
window.hideDashboard = hideDashboard;
window.showDashboard = showDashboard;
// Expose functions to global scope for inline HTML handlers
window.logout = logout;
window.showAuth = showAuth;
window.hideDashboard = hideDashboard;
// Expose confirmExitQuiz for inline handlers
window.confirmExitQuiz = confirmExitQuiz;

// Inicializar navegação por abas

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


// Implementacoes finais de autenticacao e inicializacao.
// Este bloco neutraliza definicoes duplicadas/incompletas acima sem depender de reescrita ampla.
function showError(elementId, message) {
    const el = document.getElementById(elementId);
    if (!el) return;
    el.textContent = message;
    el.className = 'error-message';
}

function showSuccess(elementId, message) {
    const el = document.getElementById(elementId);
    if (!el) return;
    el.textContent = message;
    el.className = 'success-message';
}

function getAuthErrorMessage(error) {
    if (!error) return 'Erro desconhecido.';

    const errorCode = typeof error === 'string' ? error : error.code;
    const messages = {
        'auth/invalid-email': 'E-mail invalido.',
        'auth/user-disabled': 'Esta conta foi desativada.',
        'auth/user-not-found': 'Nenhuma conta encontrada com este e-mail.',
        'auth/wrong-password': 'Senha incorreta.',
        'auth/invalid-credential': 'E-mail ou senha invalidos.',
        'auth/email-already-in-use': 'Este e-mail ja esta em uso.',
        'auth/weak-password': 'A senha deve ter pelo menos 6 caracteres.',
        'auth/operation-not-allowed': 'Metodo de login nao habilitado no Firebase Authentication.',
        'auth/unauthorized-domain': 'Dominio nao autorizado no Firebase Authentication.',
        'auth/popup-blocked': 'O popup do Google foi bloqueado. Autorize popups ou tente novamente.',
        'auth/popup-closed-by-user': 'Login com Google cancelado.',
        'auth/cancelled-popup-request': 'Ja existe uma tentativa de login com Google em andamento.',
        'auth/account-exists-with-different-credential': 'Ja existe uma conta com este e-mail usando outro metodo de login.',
        'auth/network-request-failed': 'Erro de rede. Verifique sua conexao e tente novamente.',
        'permission-denied': 'Login autenticado, mas sem permissao para acessar os dados do usuario no Firestore.',
        'unavailable': 'Servico temporariamente indisponivel. Tente novamente em instantes.'
    };

    if (errorCode && messages[errorCode]) return messages[errorCode];
    if (error.message) return error.message;
    return errorCode || 'Erro desconhecido.';
}

function normalizeAuthUserData(user, data = {}) {
    return {
        name: data.name || user.displayName || (user.email ? user.email.split('@')[0] : 'Aluno'),
        email: data.email || user.email || '',
        userType: data.userType || 'aluno',
        status: data.status || 'active',
        ...data
    };
}

function ensureUserDocument(user) {
    if (!user || !user.uid) {
        return Promise.reject(new Error('Usuario autenticado invalido.'));
    }

    const userRef = db.collection('users').doc(user.uid);

    return userRef.get().then(doc => {
        if (doc.exists) {
            const userData = normalizeAuthUserData(user, doc.data() || {});
            const patch = {};

            if (!userData.name) patch.name = user.displayName || (user.email ? user.email.split('@')[0] : 'Aluno');
            if (!userData.email && user.email) patch.email = user.email;
            if (!userData.userType) patch.userType = 'aluno';
            if (!userData.status) patch.status = 'active';

            if (Object.keys(patch).length === 0) {
                return userData;
            }

            patch.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
            return userRef.set(patch, { merge: true }).then(() => ({ ...userData, ...patch }));
        }

        const userData = normalizeAuthUserData(user, {
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });

        return userRef.set(userData, { merge: true }).then(() => userData);
    });
}

function setAuthenticatedUser(user, userData) {
    const normalized = normalizeAuthUserData(user, userData);
    currentUser = {
        uid: user.uid,
        email: user.email || normalized.email,
        displayName: user.displayName || normalized.name,
        photoURL: user.photoURL || '',
        ...normalized
    };
    return currentUser;
}

function handleInactiveUser(userData, errorElementId = 'login-error') {
    if (userData && userData.status === 'inactive' && userData.userType === 'aluno') {
        return auth.signOut().then(() => {
            currentUser = null;
            hideLoading();
            showAuth();
            showError(errorElementId, 'Sua conta foi desativada. Entre em contato com o administrador.');
            return true;
        });
    }

    return Promise.resolve(false);
}

function registerUser(name, email, password, userType) {
    showLoading();

    return authPersistenceReady
        .then(() => auth.createUserWithEmailAndPassword(email, password))
        .then(userCredential => {
            const user = userCredential.user;
            const userData = {
                name,
                email,
                userType: userType || 'aluno',
                status: 'active',
                roomIds: [],
                createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            };

            return db.collection('users').doc(user.uid).set(userData, { merge: true })
                .then(() => ({ user, userData }));
        })
        .then(({ user, userData }) => {
            setAuthenticatedUser(user, userData);
            hideLoading();
            showSuccess('register-error', 'Cadastro realizado com sucesso!');
            showDashboard();

            window.setTimeout(() => {
                const form = document.getElementById('register-form');
                if (form) form.reset();
                switchAuthTab('login');
            }, 1200);
        })
        .catch(error => {
            console.error('Erro ao registrar usuario:', error);
            hideLoading();
            showError('register-error', getAuthErrorMessage(error));
        });
}

function signInWithGoogle() {
    const provider = new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });

    showLoading();

    return authPersistenceReady
        .then(() => auth.signInWithPopup(provider))
        .then(result => ensureUserDocument(result.user).then(userData => ({ user: result.user, userData })))
        .then(({ user, userData }) => handleInactiveUser(userData).then(inactive => {
            if (inactive) return;
            setAuthenticatedUser(user, userData);
            const loginError = document.getElementById('login-error');
            if (loginError) loginError.textContent = '';
            hideLoading();
            showDashboard();
        }))
        .catch(error => {
            console.error('Erro no login com Google:', error);

            if (error && error.code === 'auth/popup-blocked') {
                return auth.signInWithRedirect(provider).catch(redirectError => {
                    hideLoading();
                    showError('login-error', getAuthErrorMessage(redirectError));
                });
            }

            hideLoading();
            showError('login-error', getAuthErrorMessage(error));
        });
}

function safeOn(elementId, eventName, handler) {
    const element = document.getElementById(elementId);
    if (!element || typeof handler !== 'function') return;
    element.addEventListener(eventName, handler);
}

function invokeIfAvailable(functionName, ...args) {
    const fn = window[functionName];
    if (typeof fn === 'function') {
        return fn(...args);
    }

    console.warn(`Funcao indisponivel: ${functionName}`);
    return null;
}

function initEventListeners() {
    safeOn('student-logout', 'click', logout);
    safeOn('admin-logout', 'click', logout);
    safeOn('teacher-logout', 'click', logout);

    initTabNavigation();
    initQuizControls();

    safeOn('back-to-dashboard', 'click', () => showDashboard());
    safeOn('new-quiz', 'click', () => {
        showDashboard();
        if (currentUser && currentUser.userType === 'aluno') {
            switchTab('quizzes-tab', 'quizzes-section');
            invokeIfAvailable('loadQuizzes');
        }
    });
    safeOn('review-quiz', 'click', () => invokeIfAvailable('handleReviewClick'));

    safeOn('create-quiz-btn', 'click', () => invokeIfAvailable('openQuizModal'));
    safeOn('create-question-btn', 'click', () => invokeIfAvailable('openQuestionModal'));
    safeOn('import-questions-btn', 'click', () => invokeIfAvailable('openImportModal'));
    safeOn('create-user-btn', 'click', () => invokeIfAvailable('openUserModal'));

    safeOn('create-room-btn', 'click', () => invokeIfAvailable('openRoomModal'));
    safeOn('teacher-create-quiz-btn', 'click', () => invokeIfAvailable('openTeacherQuizModal'));
    safeOn('create-student-btn', 'click', () => invokeIfAvailable('openTeacherUserModal'));
    safeOn('exit-quiz-btn', 'click', confirmExitQuiz);

    window.addEventListener('beforeunload', handleQuizBeforeUnload);
    window.addEventListener('pagehide', handleQuizBeforeUnload);
}

function initTabNavigation() {
    safeOn('quizzes-tab', 'click', () => {
        switchTab('quizzes-tab', 'quizzes-section');
        invokeIfAvailable('loadQuizzes');
    });
    safeOn('ranking-tab', 'click', () => {
        switchTab('ranking-tab', 'ranking-section');
        invokeIfAvailable('loadRanking');
    });
    safeOn('quiz-masters-tab', 'click', () => {
        switchTab('quiz-masters-tab', 'quiz-masters-section');
        invokeIfAvailable('loadQuizRankings');
    });
    safeOn('history-tab', 'click', () => {
        switchTab('history-tab', 'history-section');
        invokeIfAvailable('loadUserHistory');
    });
    safeOn('about-tab', 'click', () => switchTab('about-tab', 'about-section'));

    safeOn('admin-quizzes-tab', 'click', () => {
        switchAdminTab('admin-quizzes-tab', 'admin-quizzes-section');
        invokeIfAvailable('loadAdminQuizzes');
    });
    safeOn('admin-questions-tab', 'click', () => {
        switchAdminTab('admin-questions-tab', 'admin-questions-section');
        invokeIfAvailable('loadAdminQuestions');
    });
    safeOn('admin-users-tab', 'click', () => {
        switchAdminTab('admin-users-tab', 'admin-users-section');
        invokeIfAvailable('loadAdminUsers');
    });
    safeOn('admin-ranking-tab', 'click', () => {
        switchAdminTab('admin-ranking-tab', 'admin-ranking-section');
        invokeIfAvailable('loadAdminRanking');
    });
    safeOn('admin-quiz-masters-tab', 'click', () => {
        switchAdminTab('admin-quiz-masters-tab', 'admin-quiz-masters-section');
        invokeIfAvailable('loadAdminQuizRankings');
    });
    safeOn('admin-reports-tab', 'click', () => {
        switchAdminTab('admin-reports-tab', 'admin-reports-section');
        invokeIfAvailable('loadAdminReports');
    });
    safeOn('admin-about-tab', 'click', () => switchAdminTab('admin-about-tab', 'admin-about-section'));

    safeOn('teacher-rooms-tab', 'click', () => {
        switchTeacherTab('teacher-rooms-tab', 'teacher-rooms-section');
        invokeIfAvailable('loadTeacherRooms');
    });
    safeOn('teacher-quizzes-tab', 'click', () => {
        switchTeacherTab('teacher-quizzes-tab', 'teacher-quizzes-section');
        invokeIfAvailable('loadTeacherQuizzes');
    });
    safeOn('teacher-users-tab', 'click', () => {
        switchTeacherTab('teacher-users-tab', 'teacher-users-section');
        invokeIfAvailable('loadTeacherUsers');
    });
    safeOn('teacher-ranking-tab', 'click', () => {
        switchTeacherTab('teacher-ranking-tab', 'teacher-ranking-section');
        invokeIfAvailable('loadTeacherRanking');
    });
    safeOn('teacher-quiz-masters-tab', 'click', () => {
        switchTeacherTab('teacher-quiz-masters-tab', 'teacher-quiz-masters-section');
        invokeIfAvailable('loadTeacherQuizRankings');
    });
    safeOn('teacher-reports-tab', 'click', () => {
        switchTeacherTab('teacher-reports-tab', 'teacher-reports-section');
        invokeIfAvailable('loadTeacherReports');
    });
    safeOn('teacher-about-tab', 'click', () => switchTeacherTab('teacher-about-tab', 'teacher-about-section'));
}

function initQuizControls() {
    safeOn('prev-question', 'click', () => {
        if (currentQuestionIndex > 0) {
            currentQuestionIndex--;
            invokeIfAvailable('displayQuestion');
        }
    });
    safeOn('next-question', 'click', () => {
        if (currentQuestionIndex < currentQuestions.length - 1) {
            currentQuestionIndex++;
            invokeIfAvailable('displayQuestion');
        }
    });
    safeOn('finish-quiz', 'click', () => invokeIfAvailable('finishQuiz'));
}

function initModals() {
    safeOn('close-quiz-modal', 'click', () => invokeIfAvailable('closeQuizModal'));
    safeOn('cancel-quiz', 'click', () => invokeIfAvailable('closeQuizModal'));
    safeOn('save-quiz', 'click', () => invokeIfAvailable('saveQuiz'));

    safeOn('close-question-modal', 'click', () => invokeIfAvailable('closeQuestionModal'));
    safeOn('cancel-question', 'click', () => invokeIfAvailable('closeQuestionModal'));
    safeOn('save-question', 'click', () => invokeIfAvailable('saveQuestion'));

    safeOn('close-user-modal', 'click', () => invokeIfAvailable('closeUserModal'));
    safeOn('cancel-user', 'click', () => invokeIfAvailable('closeUserModal'));
    safeOn('save-user', 'click', () => invokeIfAvailable('saveUser'));

    safeOn('close-import-modal', 'click', () => invokeIfAvailable('closeImportModal'));
    safeOn('cancel-import', 'click', () => invokeIfAvailable('closeImportModal'));
    safeOn('import-questions', 'click', () => invokeIfAvailable('importQuestions'));

    safeOn('close-review-modal', 'click', () => invokeIfAvailable('closeReviewModal'));
    safeOn('close-review', 'click', () => invokeIfAvailable('closeReviewModal'));

    safeOn('close-room-modal', 'click', () => invokeIfAvailable('closeRoomModal'));
    safeOn('cancel-room', 'click', () => invokeIfAvailable('closeRoomModal'));
    safeOn('save-room', 'click', () => invokeIfAvailable('saveRoom'));

    safeOn('close-teacher-quiz-modal', 'click', () => invokeIfAvailable('closeTeacherQuizModal'));
    safeOn('cancel-teacher-quiz', 'click', () => invokeIfAvailable('closeTeacherQuizModal'));
    safeOn('save-teacher-quiz', 'click', () => invokeIfAvailable('saveTeacherQuiz'));

    safeOn('close-teacher-user-modal', 'click', () => invokeIfAvailable('closeTeacherUserModal'));
    safeOn('cancel-teacher-user', 'click', () => invokeIfAvailable('closeTeacherUserModal'));
    safeOn('save-teacher-user', 'click', () => invokeIfAvailable('saveTeacherUser'));

    document.querySelectorAll('.modal').forEach(modal => {
        modal.addEventListener('click', event => {
            if (event.target === modal) {
                modal.classList.add('hidden');
            }
        });
    });
}

window.showError = showError;
window.showSuccess = showSuccess;
window.signInWithGoogle = signInWithGoogle;
window.logout = logout;
window.showAuth = showAuth;
window.hideDashboard = hideDashboard;
window.showDashboard = showDashboard;
window.confirmExitQuiz = confirmExitQuiz;
