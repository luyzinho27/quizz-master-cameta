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
let editingTeacherTargetUserType = 'aluno';

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
            const adminOption = document.getElementById('admin-option');
            if (adminOption) {
                adminOption.disabled = true;
                adminOption.textContent = 'Administrador (verificacao indisponivel)';
            }
            return true;
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
    safeOn('admin-create-room-btn', 'click', () => invokeIfAvailable('openRoomModal'));
    safeOn('teacher-create-quiz-btn', 'click', () => invokeIfAvailable('openTeacherQuizModal'));
    safeOn('admin-create-room-quiz-btn', 'click', () => invokeIfAvailable('openTeacherQuizModal'));
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
    safeOn('admin-rooms-tab', 'click', () => {
        switchAdminTab('admin-rooms-tab', 'admin-rooms-section');
        invokeIfAvailable('loadAdminRooms');
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

// Camada funcional de CRUD para Admin e Professor.
function formatDate(value) {
    if (!value) return 'N/A';
    if (value.toDate) return value.toDate().toLocaleDateString('pt-BR');
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'N/A' : date.toLocaleDateString('pt-BR');
}

function getValue(id) {
    const element = document.getElementById(id);
    return element ? element.value.trim() : '';
}

function setValue(id, value) {
    const element = document.getElementById(id);
    if (element) element.value = value || '';
}

function setChecked(id, checked) {
    const element = document.getElementById(id);
    if (element) element.checked = Boolean(checked);
}

function setListLoading(id, text) {
    const list = document.getElementById(id);
    if (list) list.innerHTML = `<div class="card"><div class="card-content">${text}</div></div>`;
    return list;
}

function setListEmpty(id, text) {
    const list = document.getElementById(id);
    if (list) list.innerHTML = `<div class="card"><div class="card-content">${text}</div></div>`;
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function isAdminUser() {
    return currentUser && currentUser.userType === 'admin';
}

function isTeacherUser() {
    return currentUser && (currentUser.userType === 'professor' || currentUser.userType === 'prof');
}

function canManageTeacherResources() {
    return isAdminUser() || isTeacherUser();
}

function getOwnerPayload() {
    if (isAdminUser()) {
        return {
            ownerId: currentUser.uid,
            ownerName: currentUser.name || currentUser.email || 'Administrador',
            ownerType: 'admin'
        };
    }

    return {
        teacherId: currentUser.uid,
        teacherName: currentUser.name || currentUser.email || 'Professor',
        ownerId: currentUser.uid,
        ownerName: currentUser.name || currentUser.email || 'Professor',
        ownerType: 'professor'
    };
}

function addClickHandler(selector, handler) {
    document.querySelectorAll(selector).forEach(element => {
        element.addEventListener('click', handler);
    });
}

function firebaseOrderByCreatedDesc(items) {
    return items.sort((a, b) => {
        const aTime = getTimestampMs(a.createdAt) || 0;
        const bTime = getTimestampMs(b.createdAt) || 0;
        return bTime - aTime;
    });
}

function snapshotToItems(snapshot) {
    const items = [];
    snapshot.forEach(doc => items.push({ id: doc.id, ...doc.data() }));
    return items;
}

function fetchQuery(query) {
    return query.get().then(snapshotToItems);
}

function fetchCollection(name) {
    return fetchQuery(db.collection(name));
}

function fetchCollectionWhere(name, field, operator, value) {
    return fetchQuery(db.collection(name).where(field, operator, value));
}

function uniqueById(items) {
    return Array.from(new Map(items.map(item => [item.id, item])).values());
}

function fetchUsersByType(userType) {
    return fetchCollectionWhere('users', 'userType', '==', userType);
}

function fetchStudentRooms() {
    if (!currentUser) return Promise.resolve([]);
    return fetchCollectionWhere('rooms', 'studentIds', 'array-contains', currentUser.uid);
}

function fetchManagedRoomsForTeacher() {
    if (!currentUser) return Promise.resolve([]);
    return Promise.all([
        fetchCollectionWhere('rooms', 'ownerId', '==', currentUser.uid),
        fetchCollectionWhere('rooms', 'teacherId', '==', currentUser.uid)
    ]).then(results => uniqueById(results.flat()));
}

function createManagedAuthUser(email, password) {
    const secondaryName = `secondary-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const secondaryApp = firebase.initializeApp(firebaseConfig, secondaryName);
    const secondaryAuth = secondaryApp.auth();

    return secondaryAuth.createUserWithEmailAndPassword(email, password)
        .then(credential => secondaryAuth.signOut().then(() => credential.user))
        .finally(() => secondaryApp.delete());
}

function createManagedUser({ name, email, password, userType, status = 'active', roomIds = [] }) {
    if (!password || password.length < 6) {
        return Promise.reject(new Error('Informe uma senha temporaria com pelo menos 6 caracteres.'));
    }

    return createManagedAuthUser(email, password).then(authUser => {
        const userData = {
            name,
            email,
            userType,
            status,
            roomIds,
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        };

        return db.collection('users').doc(authUser.uid).set(userData, { merge: true })
            .then(() => ({ id: authUser.uid, ...userData }));
    });
}

function ensureAdminTeacherTabs() {
    const adminNav = document.querySelector('#admin-dashboard .dashboard-header .tabs');
    const adminContent = document.querySelector('#admin-dashboard .dashboard-content');

    if (adminNav && !document.getElementById('admin-rooms-tab')) {
        const roomsTab = document.createElement('button');
        roomsTab.id = 'admin-rooms-tab';
        roomsTab.className = 'tab';
        roomsTab.innerHTML = '<i class="fas fa-door-open"></i><span class="tab-text">Salas</span>';
        const usersTab = document.getElementById('admin-users-tab');
        adminNav.insertBefore(roomsTab, usersTab ? usersTab.nextSibling : null);
    }

    if (adminContent && !document.getElementById('admin-rooms-section')) {
        const roomsSection = document.createElement('div');
        roomsSection.id = 'admin-rooms-section';
        roomsSection.className = 'section';
        roomsSection.innerHTML = `
            <div class="section-header">
                <h2>Gerenciar Salas</h2>
                <p>Crie turmas, adicione alunos e organize quizzes por sala</p>
                <button id="admin-create-room-btn" class="btn btn-primary">
                    <i class="fas fa-plus"></i>
                    <span class="btn-text">Criar Sala</span>
                </button>
            </div>
            <div id="admin-rooms-list" class="cards-container"></div>
        `;
        const usersSection = document.getElementById('admin-users-section');
        adminContent.insertBefore(roomsSection, usersSection || null);
    }

}

function updateRegisterAdminOption() {
    const adminOption = document.getElementById('admin-option');
    if (!adminOption) return Promise.resolve(false);

    return checkAdminExists().then(adminExists => {
        if (adminExists) {
            adminOption.disabled = true;
            adminOption.textContent = 'Administrador (somente pelo Admin)';
            const registerType = document.getElementById('register-type');
            if (registerType && registerType.value === 'admin') registerType.value = 'aluno';
        }
        return adminExists;
    });
}

const originalSwitchAuthTab = switchAuthTab;
switchAuthTab = function(tab) {
    originalSwitchAuthTab(tab);
    if (tab === 'register') updateRegisterAdminOption();
};

function loadInitialDashboardData() {
    if (!currentUser) return;

    if (currentUser.userType === 'aluno') {
        setText('student-name', currentUser.name || currentUser.email || '');
        loadQuizzes();
        return;
    }

    if (isAdminUser()) {
        setText('admin-name', currentUser.name || currentUser.email || '');
        ensureAdminTeacherTabs();
        loadAdminQuizzes();
        return;
    }

    if (isTeacherUser()) {
        setText('teacher-name', currentUser.name || currentUser.email || '');
        loadTeacherRooms();
    }
}

function setText(id, value) {
    const element = document.getElementById(id);
    if (element) element.textContent = value || '';
}

const originalShowDashboard = showDashboard;
showDashboard = function() {
    originalShowDashboard();
    loadInitialDashboardData();
};
window.showDashboard = showDashboard;

const originalInitEventListeners = initEventListeners;
initEventListeners = function() {
    ensureAdminTeacherTabs();
    originalInitEventListeners();
    safeOn('admin-users-search', 'input', event => filterAdminUsers(event.target.value));
};
window.initEventListeners = initEventListeners;

document.addEventListener('DOMContentLoaded', () => {
    updateRegisterAdminOption();
});

function loadQuestionCategories() {
    return db.collection('questions').get().then(snapshot => {
        const categories = new Set();
        snapshot.forEach(doc => {
            const category = doc.data().category;
            if (category) categories.add(category);
        });
        return Array.from(categories).sort((a, b) => a.localeCompare(b, 'pt-BR'));
    });
}

function populateCategorySelect(selectId, selectedValue = '') {
    const select = document.getElementById(selectId);
    if (!select) return Promise.resolve();

    select.innerHTML = '<option value="">Carregando categorias...</option>';
    return loadQuestionCategories().then(categories => {
        select.innerHTML = '<option value="">Selecione uma categoria</option>';
        categories.forEach(category => {
            const option = document.createElement('option');
            option.value = category;
            option.textContent = category;
            select.appendChild(option);
        });
        if (selectedValue) select.value = selectedValue;
    });
}

function loadAvailableStudents(containerId = 'available-students-list', selectedIds = []) {
    const container = document.getElementById(containerId);
    if (!container) return Promise.resolve([]);

    container.innerHTML = '<p>Carregando alunos...</p>';
    return fetchUsersByType('aluno').then(students => {
        availableStudents = students.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'pt-BR'));

        if (availableStudents.length === 0) {
            container.innerHTML = '<p>Nenhum aluno cadastrado.</p>';
            return availableStudents;
        }

        container.innerHTML = availableStudents.map(student => `
            <label class="checkbox-row" style="margin-bottom: 0.5rem;">
                <input type="checkbox" value="${escapeHtml(student.id)}" data-student-id="${escapeHtml(student.id)}" ${selectedIds.includes(student.id) ? 'checked' : ''}>
                <span>${escapeHtml(student.name || student.email || 'Aluno')}</span>
            </label>
        `).join('');

        return availableStudents;
    });
}

function selectedStudentIdsFrom(containerId) {
    return Array.from(document.querySelectorAll(`#${containerId} input[type="checkbox"]:checked`))
        .map(input => input.value);
}

function updateSelectedStudentsDisplay() {
    const display = document.getElementById('selected-students');
    if (!display) return;
    if (!selectedStudents.length) {
        display.innerHTML = '<p>Nenhum aluno selecionado</p>';
        return;
    }
    display.innerHTML = selectedStudents.map(student => `<span class="card-badge">${escapeHtml(student.name)}</span>`).join(' ');
}

function addStudentToSelection(studentId, name) {
    if (!selectedStudents.some(student => student.id === studentId)) {
        selectedStudents.push({ id: studentId, name });
        updateSelectedStudentsDisplay();
    }
}

function filterAvailableStudents(term) {
    const normalized = (term || '').trim().toLowerCase();
    document.querySelectorAll('#available-students-list label').forEach(label => {
        label.style.display = label.textContent.toLowerCase().includes(normalized) ? '' : 'none';
    });
}

function openRoomModal(roomId = null) {
    if (!canManageTeacherResources()) return alert('Acesso negado.');
    editingRoomId = roomId;
    setText('room-modal-title', roomId ? 'Editar Sala' : 'Criar Sala');
    setValue('room-name', '');
    setValue('room-description', '');
    setValue('room-status', 'active');

    const loadRoom = roomId
        ? db.collection('rooms').doc(roomId).get().then(doc => {
            if (!doc.exists) throw new Error('Sala nao encontrada.');
            const room = doc.data();
            setValue('room-name', room.name);
            setValue('room-description', room.description || '');
            setValue('room-status', room.status || 'active');
            return room.studentIds || [];
        })
        : Promise.resolve([]);

    loadRoom
        .then(selectedIds => loadAvailableStudents('room-students-list', selectedIds))
        .then(() => document.getElementById('room-modal').classList.remove('hidden'))
        .catch(error => alert('Erro ao abrir sala: ' + getAuthErrorMessage(error)));
}

function closeRoomModal() {
    document.getElementById('room-modal').classList.add('hidden');
    editingRoomId = null;
}

function saveRoom() {
    if (!canManageTeacherResources()) return alert('Acesso negado.');

    const name = getValue('room-name');
    if (!name) return alert('Informe o nome da sala.');

    const roomData = {
        name,
        description: getValue('room-description'),
        status: getValue('room-status') || 'active',
        studentIds: selectedStudentIdsFrom('room-students-list'),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        ...getOwnerPayload()
    };

    const request = editingRoomId
        ? db.collection('rooms').doc(editingRoomId).set(roomData, { merge: true })
        : db.collection('rooms').add({ ...roomData, createdAt: firebase.firestore.FieldValue.serverTimestamp() });

    request.then(() => {
        alert('Sala salva com sucesso!');
        closeRoomModal();
        isAdminUser() ? loadAdminRooms() : loadTeacherRooms();
    }).catch(error => alert('Erro ao salvar sala: ' + getAuthErrorMessage(error)));
}

function roomVisibleForCurrentUser(room) {
    return isAdminUser() || room.teacherId === currentUser.uid || room.ownerId === currentUser.uid;
}

function getManagedRooms() {
    if (isAdminUser()) {
        return fetchCollection('rooms').then(rooms => firebaseOrderByCreatedDesc(rooms));
    }

    if (isTeacherUser()) {
        return fetchManagedRoomsForTeacher().then(rooms => firebaseOrderByCreatedDesc(rooms.filter(roomVisibleForCurrentUser)));
    }

    return Promise.resolve([]);
}

function renderRooms(listId, rooms) {
    const list = document.getElementById(listId);
    if (!list) return;
    if (!rooms.length) return setListEmpty(listId, 'Nenhuma sala cadastrada.');

    list.innerHTML = rooms.map(room => `
        <div class="card">
            <div class="card-header">
                <h3 class="card-title">${escapeHtml(room.name)}</h3>
                <span class="card-badge ${room.status === 'active' ? '' : 'card-badge-secondary'}">${room.status === 'active' ? 'Ativa' : 'Inativa'}</span>
            </div>
            <div class="card-content">
                <p>${escapeHtml(room.description || 'Sem descricao')}</p>
                <p><strong>Alunos:</strong> ${(room.studentIds || []).length}</p>
                <p><strong>Responsavel:</strong> ${escapeHtml(room.teacherName || room.ownerName || 'N/A')}</p>
                <p><strong>Criada em:</strong> ${formatDate(room.createdAt)}</p>
            </div>
            <div class="card-actions">
                <button class="btn btn-primary room-edit" data-id="${escapeHtml(room.id)}"><i class="fas fa-edit"></i><span class="btn-text">Editar</span></button>
                <button class="btn btn-danger room-delete" data-id="${escapeHtml(room.id)}"><i class="fas fa-trash"></i><span class="btn-text">Excluir</span></button>
            </div>
        </div>
    `).join('');

    addClickHandler(`#${listId} .room-edit`, event => openRoomModal(event.currentTarget.dataset.id));
    addClickHandler(`#${listId} .room-delete`, event => deleteRoom(event.currentTarget.dataset.id));
}

function loadTeacherRooms() {
    setListLoading('teacher-rooms-list', 'Carregando salas...');
    return getManagedRooms()
        .then(rooms => {
            teacherRoomsCache = rooms;
            renderRooms('teacher-rooms-list', rooms);
        })
        .catch(error => {
            console.error('Erro ao carregar salas:', error);
            setListEmpty('teacher-rooms-list', 'Erro ao carregar salas.');
        });
}

function loadAdminRooms() {
    setListLoading('admin-rooms-list', 'Carregando salas...');
    return getManagedRooms()
        .then(rooms => renderRooms('admin-rooms-list', rooms))
        .catch(error => {
            console.error('Erro ao carregar salas:', error);
            setListEmpty('admin-rooms-list', 'Erro ao carregar salas.');
        });
}

function deleteRoom(roomId) {
    if (!confirm('Tem certeza que deseja excluir esta sala?')) return;
    db.collection('rooms').doc(roomId).delete()
        .then(() => {
            alert('Sala excluida com sucesso!');
            isAdminUser() ? loadAdminRooms() : loadTeacherRooms();
        })
        .catch(error => alert('Erro ao excluir sala: ' + getAuthErrorMessage(error)));
}

function openTeacherQuizModal(quizId = null) {
    if (!canManageTeacherResources()) return alert('Acesso negado.');
    editingTeacherQuizId = quizId;
    setText('teacher-quiz-modal-title', quizId ? 'Editar Quiz da Sala' : 'Criar Quiz da Sala');
    ['teacher-quiz-title', 'teacher-quiz-description', 'teacher-quiz-questions-count', 'teacher-quiz-time'].forEach(id => setValue(id, ''));
    setValue('teacher-quiz-status', 'active');
    setChecked('teacher-allow-review', true);

    Promise.all([populateCategorySelect('teacher-quiz-category'), getManagedRooms()])
        .then(([, rooms]) => {
            const roomSelect = document.getElementById('teacher-quiz-room');
            roomSelect.innerHTML = '<option value="">Selecione uma sala</option>';
            rooms.filter(room => room.status !== 'inactive').forEach(room => {
                const option = document.createElement('option');
                option.value = room.id;
                option.textContent = room.name;
                roomSelect.appendChild(option);
            });

            if (!quizId) return null;
            return db.collection('quizzes').doc(quizId).get().then(doc => {
                if (!doc.exists) throw new Error('Quiz nao encontrado.');
                const quiz = doc.data();
                setValue('teacher-quiz-title', quiz.title);
                setValue('teacher-quiz-description', quiz.description || '');
                setValue('teacher-quiz-category', quiz.category || '');
                setValue('teacher-quiz-room', quiz.roomId || '');
                setValue('teacher-quiz-questions-count', quiz.questionsCount || '');
                setValue('teacher-quiz-time', quiz.time || '');
                setValue('teacher-quiz-status', quiz.status || 'active');
                setChecked('teacher-allow-review', quiz.allowReview !== false);
            });
        })
        .then(() => document.getElementById('teacher-quiz-modal').classList.remove('hidden'))
        .catch(error => alert('Erro ao abrir quiz: ' + getAuthErrorMessage(error)));
}

function closeTeacherQuizModal() {
    document.getElementById('teacher-quiz-modal').classList.add('hidden');
    editingTeacherQuizId = null;
}

function saveTeacherQuiz() {
    if (!canManageTeacherResources()) return alert('Acesso negado.');
    const title = getValue('teacher-quiz-title');
    const category = getValue('teacher-quiz-category');
    const roomId = getValue('teacher-quiz-room');
    const questionsCount = Number(getValue('teacher-quiz-questions-count'));
    const time = Number(getValue('teacher-quiz-time'));

    if (!title || !category || !roomId || !questionsCount || !time) {
        return alert('Preencha titulo, categoria, sala, numero de questoes e tempo.');
    }

    const quizData = {
        title,
        description: getValue('teacher-quiz-description'),
        category,
        roomId,
        questionsCount,
        time,
        status: getValue('teacher-quiz-status') || 'active',
        visibility: 'room',
        allowReview: document.getElementById('teacher-allow-review').checked,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        ...getOwnerPayload()
    };

    const request = editingTeacherQuizId
        ? db.collection('quizzes').doc(editingTeacherQuizId).set(quizData, { merge: true })
        : db.collection('quizzes').add({ ...quizData, createdAt: firebase.firestore.FieldValue.serverTimestamp() });

    request.then(() => {
        alert('Quiz salvo com sucesso!');
        closeTeacherQuizModal();
        isAdminUser() ? loadAdminQuizzes() : loadTeacherQuizzes();
    }).catch(error => alert('Erro ao salvar quiz: ' + getAuthErrorMessage(error)));
}

function quizVisibleForCurrentTeacher(quiz, roomIds = []) {
    return isAdminUser() || quiz.teacherId === currentUser.uid || quiz.ownerId === currentUser.uid || (quiz.roomId && roomIds.includes(quiz.roomId));
}

function renderTeacherQuizzes(listId, quizzes, rooms = []) {
    const list = document.getElementById(listId);
    if (!list) return;
    if (!quizzes.length) return setListEmpty(listId, 'Nenhum quiz cadastrado.');
    const roomsMap = Object.fromEntries(rooms.map(room => [room.id, room]));

    list.innerHTML = quizzes.map(quiz => `
        <div class="card">
            <div class="card-header">
                <h3 class="card-title">${escapeHtml(quiz.title)}</h3>
                <span class="card-badge ${quiz.status === 'active' ? '' : 'card-badge-secondary'}">${quiz.status === 'active' ? 'Ativo' : 'Inativo'}</span>
            </div>
            <div class="card-content">
                <p>${escapeHtml(quiz.description || 'Sem descricao')}</p>
                <p><strong>Categoria:</strong> ${escapeHtml(quiz.category || 'Geral')}</p>
                <p><strong>Sala:</strong> ${escapeHtml(roomsMap[quiz.roomId]?.name || 'Sem sala')}</p>
                <p><strong>Questoes:</strong> ${quiz.questionsCount || 0}</p>
                <p><strong>Tempo:</strong> ${quiz.time || 0} minutos</p>
            </div>
            <div class="card-actions">
                <button class="btn btn-primary teacher-quiz-edit" data-id="${escapeHtml(quiz.id)}"><i class="fas fa-edit"></i><span class="btn-text">Editar</span></button>
                <button class="btn btn-danger teacher-quiz-delete" data-id="${escapeHtml(quiz.id)}"><i class="fas fa-trash"></i><span class="btn-text">Excluir</span></button>
            </div>
        </div>
    `).join('');

    addClickHandler(`#${listId} .teacher-quiz-edit`, event => openTeacherQuizModal(event.currentTarget.dataset.id));
    addClickHandler(`#${listId} .teacher-quiz-delete`, event => deleteQuiz(event.currentTarget.dataset.id, () => {
        isAdminUser() ? loadAdminQuizzes() : loadTeacherQuizzes();
    }));
}

function loadTeacherQuizzes() {
    setListLoading('teacher-quizzes-list', 'Carregando quizzes...');
    return Promise.all([getManagedRooms(), fetchCollection('quizzes')])
        .then(([rooms, quizzes]) => {
            const roomIds = rooms.map(room => room.id);
            const visible = firebaseOrderByCreatedDesc(quizzes.filter(quiz => quizVisibleForCurrentTeacher(quiz, roomIds)));
            teacherQuizzesCache = visible;
            renderTeacherQuizzes('teacher-quizzes-list', visible, rooms);
        })
        .catch(error => {
            console.error('Erro ao carregar quizzes do professor:', error);
            setListEmpty('teacher-quizzes-list', 'Erro ao carregar quizzes.');
        });
}

function openTeacherUserModal(userId = null) {
    if (!canManageTeacherResources()) return alert('Acesso negado.');
    editingTeacherUserId = userId;
    editingTeacherTargetUserType = 'aluno';
    setText('teacher-user-modal-title', userId ? 'Editar Usuario' : 'Cadastrar Aluno');
    ['teacher-user-name', 'teacher-user-email', 'teacher-user-password'].forEach(id => setValue(id, ''));
    setValue('teacher-user-status', 'active');

    Promise.all([
        getManagedRooms(),
        userId ? db.collection('users').doc(userId).get() : Promise.resolve(null)
    ]).then(([rooms, userDoc]) => {
        let selectedRoomIds = [];
        if (userDoc && userDoc.exists) {
            const user = userDoc.data();
            if (isTeacherUser() && userId !== currentUser.uid && user.userType !== 'aluno') {
                throw new Error('Acesso negado a este usuario.');
            }

            editingTeacherTargetUserType = user.userType || 'aluno';
            const isOwnProfile = isTeacherUser() && userId === currentUser.uid;
            setText('teacher-user-modal-title', isOwnProfile ? 'Editar Meu Cadastro' : 'Editar Aluno');
            setValue('teacher-user-name', user.name || '');
            setValue('teacher-user-email', user.email || '');
            setValue('teacher-user-status', user.status || 'active');
            selectedRoomIds = user.roomIds || [];
        }

        const roomList = document.getElementById('teacher-user-rooms-list');
        const isOwnProfile = isTeacherUser() && userId === currentUser.uid;
        roomList.innerHTML = isOwnProfile
            ? '<p>Seu usuario de professor nao e vinculado a salas como aluno.</p>'
            : rooms.length
            ? rooms.map(room => `
                <label class="checkbox-row" style="margin-bottom: 0.5rem;">
                    <input type="checkbox" value="${escapeHtml(room.id)}" ${selectedRoomIds.includes(room.id) ? 'checked' : ''}>
                    <span>${escapeHtml(room.name)}</span>
                </label>
            `).join('')
            : '<p>Nenhuma sala cadastrada.</p>';

        document.getElementById('teacher-user-modal').classList.remove('hidden');
    }).catch(error => alert('Erro ao abrir aluno: ' + getAuthErrorMessage(error)));
}

function closeTeacherUserModal() {
    document.getElementById('teacher-user-modal').classList.add('hidden');
    editingTeacherUserId = null;
    editingTeacherTargetUserType = 'aluno';
}

function selectedRoomIdsFromTeacherUserModal() {
    return Array.from(document.querySelectorAll('#teacher-user-rooms-list input[type="checkbox"]:checked')).map(input => input.value);
}

function saveTeacherUser() {
    if (!canManageTeacherResources()) return alert('Acesso negado.');
    const name = getValue('teacher-user-name');
    const email = getValue('teacher-user-email');
    const password = getValue('teacher-user-password');
    const status = getValue('teacher-user-status') || 'active';
    const roomIds = selectedRoomIdsFromTeacherUserModal();
    const isOwnProfile = isTeacherUser() && editingTeacherUserId === currentUser.uid;

    if (!name || !email) return alert('Preencha nome e e-mail.');

    const finish = () => {
        closeTeacherUserModal();
        isAdminUser() ? loadAdminUsers() : loadTeacherUsers();
    };

    if (editingTeacherUserId) {
        const userData = {
            name,
            email,
            userType: isOwnProfile ? editingTeacherTargetUserType : 'aluno',
            status,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        };

        if (!isOwnProfile) {
            userData.roomIds = roomIds;
        }

        db.collection('users').doc(editingTeacherUserId).set(userData, { merge: true }).then(() => {
            if (isOwnProfile) {
                currentUser = { ...currentUser, name, email, status };
                setText('teacher-name', name || email);
            }
            alert(isOwnProfile ? 'Cadastro atualizado com sucesso!' : 'Aluno atualizado com sucesso!');
            finish();
        }).catch(error => alert('Erro ao atualizar usuario: ' + getAuthErrorMessage(error)));
        return;
    }

    createManagedUser({ name, email, password, userType: 'aluno', status, roomIds })
        .then(() => {
            alert('Aluno criado com sucesso!');
            finish();
        })
        .catch(error => alert('Erro ao criar aluno: ' + getAuthErrorMessage(error)));
}

function loadTeacherUsers() {
    setListLoading('teacher-users-list', 'Carregando alunos...');
    const usersRequest = isAdminUser()
        ? fetchCollection('users')
        : Promise.all([
            fetchUsersByType('aluno'),
            currentUser ? db.collection('users').doc(currentUser.uid).get() : Promise.resolve(null)
        ]).then(([students, ownDoc]) => {
            const ownUser = ownDoc && ownDoc.exists ? { id: ownDoc.id, ...ownDoc.data() } : null;
            return uniqueById([ownUser, ...students].filter(Boolean));
        });

    return usersRequest
        .then(users => {
            teacherUsersCache = users.sort((a, b) => {
                if (a.id === currentUser.uid) return -1;
                if (b.id === currentUser.uid) return 1;
                return (a.name || '').localeCompare(b.name || '', 'pt-BR');
            });
            renderUsers('teacher-users-list', teacherUsersCache, { teacherMode: true, allowDelete: false });
        })
        .catch(error => {
            console.error('Erro ao carregar alunos:', error);
            setListEmpty('teacher-users-list', 'Erro ao carregar alunos.');
        });
}

function renderUsers(listId, users, options = {}) {
    const list = document.getElementById(listId);
    if (!list) return;
    if (!users.length) return setListEmpty(listId, 'Nenhum usuario encontrado.');
    const allowDelete = options.allowDelete !== false;

    list.innerHTML = users.map(user => `
        <div class="card">
            <div class="card-header">
                <h3 class="card-title">${escapeHtml(user.name || 'Sem nome')}</h3>
                <span class="card-badge ${user.status === 'inactive' ? 'card-badge-secondary' : ''}">${user.status === 'inactive' ? 'Inativo' : 'Ativo'}</span>
            </div>
            <div class="card-content">
                <p><strong>E-mail:</strong> ${escapeHtml(user.email || 'N/A')}</p>
                <p><strong>Tipo:</strong> ${escapeHtml(user.userType || 'aluno')}</p>
                <p><strong>Salas:</strong> ${(user.roomIds || []).length}</p>
                <p><strong>Criado em:</strong> ${formatDate(user.createdAt)}</p>
            </div>
            <div class="card-actions">
                <button class="btn btn-primary user-edit" data-id="${escapeHtml(user.id)}"><i class="fas fa-edit"></i><span class="btn-text">Editar</span></button>
                <button class="btn btn-secondary user-toggle" data-id="${escapeHtml(user.id)}" data-status="${escapeHtml(user.status || 'active')}"><i class="fas fa-power-off"></i><span class="btn-text">${user.status === 'inactive' ? 'Ativar' : 'Desativar'}</span></button>
                ${allowDelete ? `<button class="btn btn-danger user-delete" data-id="${escapeHtml(user.id)}"><i class="fas fa-trash"></i><span class="btn-text">Excluir</span></button>` : ''}
            </div>
        </div>
    `).join('');

    addClickHandler(`#${listId} .user-edit`, event => options.teacherMode ? openTeacherUserModal(event.currentTarget.dataset.id) : openUserModal(event.currentTarget.dataset.id));
    addClickHandler(`#${listId} .user-toggle`, event => toggleUserStatus(event.currentTarget.dataset.id, event.currentTarget.dataset.status === 'inactive' ? 'active' : 'inactive'));
    if (allowDelete) {
        addClickHandler(`#${listId} .user-delete`, event => deleteUser(event.currentTarget.dataset.id));
    }
}

function loadAdminUsers() {
    setListLoading('admin-users-list', 'Carregando usuarios...');
    return fetchCollection('users')
        .then(users => {
            adminUsersCache = users.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'pt-BR'));
            filterAdminUsers(document.getElementById('admin-users-search')?.value || '');
        })
        .catch(error => {
            console.error('Erro ao carregar usuarios:', error);
            setListEmpty('admin-users-list', 'Erro ao carregar usuarios.');
        });
}

function filterAdminUsers(query) {
    const term = (query || '').trim().toLowerCase();
    const users = term
        ? adminUsersCache.filter(user => `${user.name || ''} ${user.email || ''} ${user.userType || ''}`.toLowerCase().includes(term))
        : adminUsersCache;
    renderUsers('admin-users-list', users);
}

function openUserModal(userId = null) {
    if (!isAdminUser()) return alert('Apenas administradores podem gerenciar usuarios.');
    editingUserId = userId;
    setText('user-modal-title', userId ? 'Editar Usuario' : 'Criar Usuario');
    ['user-name', 'user-email', 'user-password'].forEach(id => setValue(id, ''));
    setValue('user-type', 'aluno');
    setValue('user-status', 'active');

    if (!userId) {
        document.getElementById('user-modal').classList.remove('hidden');
        return;
    }

    db.collection('users').doc(userId).get().then(doc => {
        if (!doc.exists) throw new Error('Usuario nao encontrado.');
        const user = doc.data();
        setValue('user-name', user.name || '');
        setValue('user-email', user.email || '');
        setValue('user-type', user.userType || 'aluno');
        setValue('user-status', user.status || 'active');
        document.getElementById('user-modal').classList.remove('hidden');
    }).catch(error => alert('Erro ao abrir usuario: ' + getAuthErrorMessage(error)));
}

function closeUserModal() {
    document.getElementById('user-modal').classList.add('hidden');
    editingUserId = null;
}

function saveUser() {
    if (!isAdminUser()) return alert('Apenas administradores podem gerenciar usuarios.');
    const name = getValue('user-name');
    const email = getValue('user-email');
    const password = getValue('user-password');
    const userType = getValue('user-type') || 'aluno';
    const status = getValue('user-status') || 'active';

    if (!name || !email) return alert('Preencha nome e e-mail.');

    if (editingUserId) {
        db.collection('users').doc(editingUserId).set({
            name,
            email,
            userType,
            status,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true }).then(() => {
            alert('Usuario atualizado com sucesso!');
            closeUserModal();
            loadAdminUsers();
        }).catch(error => alert('Erro ao atualizar usuario: ' + getAuthErrorMessage(error)));
        return;
    }

    createManagedUser({ name, email, password, userType, status })
        .then(() => {
            alert('Usuario criado com sucesso!');
            closeUserModal();
            loadAdminUsers();
        })
        .catch(error => alert('Erro ao criar usuario: ' + getAuthErrorMessage(error)));
}

function toggleUserStatus(userId, status) {
    db.collection('users').doc(userId).set({
        status,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true }).then(() => {
        if (isAdminUser()) loadAdminUsers();
        if (isTeacherUser()) loadTeacherUsers();
    }).catch(error => alert('Erro ao alterar status: ' + getAuthErrorMessage(error)));
}

function deleteUser(userId) {
    if (!isAdminUser()) return alert('Apenas administradores podem excluir usuarios.');
    if (!confirm('Tem certeza que deseja excluir este usuario do Firestore?')) return;
    db.collection('users').doc(userId).delete()
        .then(() => {
            alert('Usuario excluido com sucesso!');
            isAdminUser() ? loadAdminUsers() : loadTeacherUsers();
        })
        .catch(error => alert('Erro ao excluir usuario: ' + getAuthErrorMessage(error)));
}

function openQuizModal(quizId = null) {
    if (!isAdminUser()) return alert('Apenas administradores podem gerenciar quizzes globais.');
    editingQuizId = quizId;
    setText('quiz-modal-title', quizId ? 'Editar Quiz' : 'Criar Novo Quiz');
    selectedStudents = [];
    ['quiz-title', 'quiz-description', 'quiz-questions-count', 'quiz-time'].forEach(id => setValue(id, ''));
    setValue('quiz-status', 'active');
    setValue('quiz-visibility', 'all');
    setChecked('allow-review', true);
    document.getElementById('specific-students-container').classList.add('hidden');
    updateSelectedStudentsDisplay();

    populateCategorySelect('quiz-category').then(() => {
        if (!quizId) return null;
        return db.collection('quizzes').doc(quizId).get().then(doc => {
            if (!doc.exists) throw new Error('Quiz nao encontrado.');
            const quiz = doc.data();
            setValue('quiz-title', quiz.title);
            setValue('quiz-description', quiz.description || '');
            setValue('quiz-category', quiz.category || '');
            setValue('quiz-questions-count', quiz.questionsCount || '');
            setValue('quiz-time', quiz.time || '');
            setValue('quiz-status', quiz.status || 'active');
            setValue('quiz-visibility', quiz.visibility || 'all');
            setChecked('allow-review', quiz.allowReview !== false);
            if (quiz.visibility === 'specific') {
                document.getElementById('specific-students-container').classList.remove('hidden');
                selectedStudents = [];
                loadAvailableStudents('available-students-list', quiz.allowedStudents || []).then(students => {
                    selectedStudents = students
                        .filter(student => (quiz.allowedStudents || []).includes(student.id))
                        .map(student => ({ id: student.id, name: student.name || student.email }));
                    updateSelectedStudentsDisplay();
                });
            }
        });
    }).then(() => document.getElementById('quiz-modal').classList.remove('hidden'))
      .catch(error => alert('Erro ao abrir quiz: ' + getAuthErrorMessage(error)));
}

function closeQuizModal() {
    document.getElementById('quiz-modal').classList.add('hidden');
    editingQuizId = null;
    selectedStudents = [];
}

function saveQuiz() {
    if (!isAdminUser()) return alert('Apenas administradores podem gerenciar quizzes globais.');
    const visibility = getValue('quiz-visibility') || 'all';
    const selectedIds = visibility === 'specific' ? selectedStudentIdsFrom('available-students-list') : [];
    const quizData = {
        title: getValue('quiz-title'),
        description: getValue('quiz-description'),
        category: getValue('quiz-category'),
        questionsCount: Number(getValue('quiz-questions-count')),
        time: Number(getValue('quiz-time')),
        status: getValue('quiz-status') || 'active',
        visibility,
        allowedStudents: selectedIds,
        allowReview: document.getElementById('allow-review').checked,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        ownerType: 'admin',
        ownerId: currentUser.uid
    };

    if (!quizData.title || !quizData.category || !quizData.questionsCount || !quizData.time) {
        return alert('Preencha titulo, categoria, numero de questoes e tempo.');
    }
    if (visibility === 'specific' && selectedIds.length === 0) {
        return alert('Selecione pelo menos um aluno.');
    }

    const request = editingQuizId
        ? db.collection('quizzes').doc(editingQuizId).set(quizData, { merge: true })
        : db.collection('quizzes').add({ ...quizData, createdAt: firebase.firestore.FieldValue.serverTimestamp() });

    request.then(() => {
        alert('Quiz salvo com sucesso!');
        closeQuizModal();
        loadAdminQuizzes();
    }).catch(error => alert('Erro ao salvar quiz: ' + getAuthErrorMessage(error)));
}

function renderAdminQuizzes(quizzes) {
    const list = document.getElementById('admin-quizzes-list');
    if (!list) return;
    if (!quizzes.length) return setListEmpty('admin-quizzes-list', 'Nenhum quiz cadastrado.');

    list.innerHTML = quizzes.map(quiz => `
        <div class="card">
            <div class="card-header">
                <h3 class="card-title">${escapeHtml(quiz.title || 'Sem titulo')}</h3>
                <span class="card-badge ${quiz.status === 'active' ? '' : 'card-badge-secondary'}">${quiz.status === 'active' ? 'Ativo' : 'Inativo'}</span>
            </div>
            <div class="card-content">
                <p>${escapeHtml(quiz.description || 'Sem descricao')}</p>
                <p><strong>Categoria:</strong> ${escapeHtml(quiz.category || 'Geral')}</p>
                <p><strong>Questoes:</strong> ${quiz.questionsCount || 0}</p>
                <p><strong>Tempo:</strong> ${quiz.time || 0} minutos</p>
                <p><strong>Visibilidade:</strong> ${escapeHtml(quiz.visibility || 'all')}</p>
            </div>
            <div class="card-actions">
                <button class="btn btn-primary quiz-edit" data-id="${escapeHtml(quiz.id)}"><i class="fas fa-edit"></i><span class="btn-text">Editar</span></button>
                <button class="btn btn-danger quiz-delete" data-id="${escapeHtml(quiz.id)}"><i class="fas fa-trash"></i><span class="btn-text">Excluir</span></button>
            </div>
        </div>
    `).join('');

    addClickHandler('#admin-quizzes-list .quiz-edit', event => {
        const quiz = quizzes.find(item => item.id === event.currentTarget.dataset.id);
        if (quiz && quiz.roomId) openTeacherQuizModal(quiz.id);
        else openQuizModal(event.currentTarget.dataset.id);
    });
    addClickHandler('#admin-quizzes-list .quiz-delete', event => deleteQuiz(event.currentTarget.dataset.id, loadAdminQuizzes));
}

function loadAdminQuizzes() {
    setListLoading('admin-quizzes-list', 'Carregando quizzes...');
    return fetchCollection('quizzes')
        .then(quizzes => renderAdminQuizzes(firebaseOrderByCreatedDesc(quizzes)))
        .catch(error => {
            console.error('Erro ao carregar quizzes:', error);
            setListEmpty('admin-quizzes-list', 'Erro ao carregar quizzes.');
        });
}

function deleteQuiz(quizId, onDone = loadAdminQuizzes) {
    if (!confirm('Tem certeza que deseja excluir este quiz?')) return;
    db.collection('quizzes').doc(quizId).delete()
        .then(() => {
            alert('Quiz excluido com sucesso!');
            onDone();
        })
        .catch(error => alert('Erro ao excluir quiz: ' + getAuthErrorMessage(error)));
}

function openQuestionModal(questionId = null) {
    if (!isAdminUser()) return alert('Apenas administradores podem gerenciar questoes.');
    editingQuestionId = questionId;
    setText('question-modal-title', questionId ? 'Editar Questao' : 'Adicionar Nova Questao');
    ['question-text', 'question-category', 'option-a', 'option-b', 'option-c', 'option-d'].forEach(id => setValue(id, ''));
    setValue('correct-answer', 'a');

    if (!questionId) {
        document.getElementById('question-modal').classList.remove('hidden');
        return;
    }

    db.collection('questions').doc(questionId).get().then(doc => {
        if (!doc.exists) throw new Error('Questao nao encontrada.');
        const question = doc.data();
        setValue('question-text', question.text || '');
        setValue('question-category', question.category || '');
        setValue('option-a', question.options?.a || '');
        setValue('option-b', question.options?.b || '');
        setValue('option-c', question.options?.c || '');
        setValue('option-d', question.options?.d || '');
        setValue('correct-answer', question.correctAnswer || 'a');
        document.getElementById('question-modal').classList.remove('hidden');
    }).catch(error => alert('Erro ao abrir questao: ' + getAuthErrorMessage(error)));
}

function closeQuestionModal() {
    document.getElementById('question-modal').classList.add('hidden');
    editingQuestionId = null;
}

function saveQuestion() {
    if (!isAdminUser()) return alert('Apenas administradores podem gerenciar questoes.');
    const data = {
        text: getValue('question-text'),
        category: getValue('question-category') || 'Geral',
        options: {
            a: getValue('option-a'),
            b: getValue('option-b'),
            c: getValue('option-c'),
            d: getValue('option-d')
        },
        correctAnswer: getValue('correct-answer') || 'a',
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };

    if (!data.text || !data.options.a || !data.options.b || !data.options.c || !data.options.d) {
        return alert('Preencha o enunciado e todas as alternativas.');
    }

    const request = editingQuestionId
        ? db.collection('questions').doc(editingQuestionId).set(data, { merge: true })
        : db.collection('questions').add({ ...data, createdAt: firebase.firestore.FieldValue.serverTimestamp() });

    request.then(() => {
        alert('Questao salva com sucesso!');
        closeQuestionModal();
        loadAdminQuestions();
    }).catch(error => alert('Erro ao salvar questao: ' + getAuthErrorMessage(error)));
}

function renderQuestions(questions) {
    const list = document.getElementById('admin-questions-list');
    if (!list) return;
    if (!questions.length) return setListEmpty('admin-questions-list', 'Nenhuma questao cadastrada.');

    list.innerHTML = questions.map(question => `
        <div class="card question-card">
            <div class="card-header">
                <h3 class="card-title">${escapeHtml((question.text || '').slice(0, 90))}</h3>
                <span class="card-badge">${escapeHtml(question.category || 'Geral')}</span>
            </div>
            <div class="card-content">
                <p><strong>A:</strong> ${escapeHtml(question.options?.a || '')}</p>
                <p><strong>B:</strong> ${escapeHtml(question.options?.b || '')}</p>
                <p><strong>C:</strong> ${escapeHtml(question.options?.c || '')}</p>
                <p><strong>D:</strong> ${escapeHtml(question.options?.d || '')}</p>
                <p><strong>Resposta:</strong> ${(question.correctAnswer || '').toUpperCase()}</p>
            </div>
            <div class="card-actions">
                <button class="btn btn-primary question-edit" data-id="${escapeHtml(question.id)}"><i class="fas fa-edit"></i><span class="btn-text">Editar</span></button>
                <button class="btn btn-danger question-delete" data-id="${escapeHtml(question.id)}"><i class="fas fa-trash"></i><span class="btn-text">Excluir</span></button>
            </div>
        </div>
    `).join('');

    addClickHandler('#admin-questions-list .question-edit', event => openQuestionModal(event.currentTarget.dataset.id));
    addClickHandler('#admin-questions-list .question-delete', event => deleteQuestion(event.currentTarget.dataset.id));
}

function loadAdminQuestions() {
    setListLoading('admin-questions-list', 'Carregando questoes...');
    return fetchCollection('questions')
        .then(questions => renderQuestions(firebaseOrderByCreatedDesc(questions)))
        .catch(error => {
            console.error('Erro ao carregar questoes:', error);
            setListEmpty('admin-questions-list', 'Erro ao carregar questoes.');
        });
}

function deleteQuestion(questionId) {
    if (!confirm('Tem certeza que deseja excluir esta questao?')) return;
    db.collection('questions').doc(questionId).delete()
        .then(() => {
            alert('Questao excluida com sucesso!');
            loadAdminQuestions();
        })
        .catch(error => alert('Erro ao excluir questao: ' + getAuthErrorMessage(error)));
}

function openImportModal() {
    document.getElementById('import-modal').classList.remove('hidden');
}

function closeImportModal() {
    document.getElementById('import-modal').classList.add('hidden');
}

function importQuestions() {
    let questions;
    try {
        questions = JSON.parse(document.getElementById('json-data').value);
    } catch (error) {
        return alert('JSON invalido.');
    }
    if (!Array.isArray(questions) || questions.length === 0) return alert('Informe um array de questoes.');

    const batch = db.batch();
    questions.forEach(question => {
        const ref = db.collection('questions').doc();
        batch.set(ref, {
            text: question.text || '',
            category: question.category || 'Geral',
            options: question.options || {},
            correctAnswer: question.correctAnswer || 'a',
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
    });

    batch.commit().then(() => {
        alert('Questoes importadas com sucesso!');
        closeImportModal();
        loadAdminQuestions();
    }).catch(error => alert('Erro ao importar questoes: ' + getAuthErrorMessage(error)));
}

function loadQuizzes() {
    const list = setListLoading('quizzes-list', 'Carregando quizzes...');
    if (!list) return Promise.resolve();
    return Promise.all([fetchCollection('quizzes'), fetchStudentRooms()])
        .then(([quizzes, rooms]) => {
            const activeRooms = rooms.filter(room => (room.studentIds || []).includes(currentUser.uid));
            const roomIds = activeRooms.map(room => room.id);
            const visible = quizzes.filter(quiz => {
                if (quiz.status !== 'active') return false;
                if (quiz.visibility === 'specific') return (quiz.allowedStudents || []).includes(currentUser.uid);
                if (quiz.visibility === 'room') return quiz.roomId && roomIds.includes(quiz.roomId);
                return !quiz.visibility || quiz.visibility === 'all';
            });

            if (!visible.length) return setListEmpty('quizzes-list', 'Nenhum quiz disponivel.');
            list.innerHTML = firebaseOrderByCreatedDesc(visible).map(quiz => `
                <div class="card">
                    <div class="card-header"><h3 class="card-title">${escapeHtml(quiz.title)}</h3><span class="card-badge">${escapeHtml(quiz.category || 'Geral')}</span></div>
                    <div class="card-content">
                        <p>${escapeHtml(quiz.description || 'Sem descricao')}</p>
                        <p><strong>Questoes:</strong> ${quiz.questionsCount || 0}</p>
                        <p><strong>Tempo:</strong> ${quiz.time || 0} minutos</p>
                    </div>
                    <div class="card-actions">
                        <button class="btn btn-primary quiz-start" data-id="${escapeHtml(quiz.id)}"><i class="fas fa-play"></i><span class="btn-text">Iniciar</span></button>
                    </div>
                </div>
            `).join('');
            addClickHandler('#quizzes-list .quiz-start', event => alert('Fluxo de realizacao do quiz ainda precisa ser reconectado a partir do backup completo.'));
        })
        .catch(error => {
            console.error('Erro ao carregar quizzes:', error);
            setListEmpty('quizzes-list', 'Erro ao carregar quizzes.');
        });
}

function loadRanking() {
    return loadGenericRanking('ranking-list');
}

function loadAdminRanking() {
    return loadGenericRanking('admin-ranking-list');
}

function loadTeacherRanking() {
    const listId = 'teacher-ranking-list';
    const list = setListLoading(listId, 'Carregando ranking...');
    if (!list) return Promise.resolve();

    return Promise.all([getManagedRooms(), fetchUsersByType('aluno'), fetchCollection('userQuizzes')])
        .then(([rooms, students, results]) => {
            const roomIds = rooms.map(room => room.id);
            const visibleStudents = students.filter(student => (student.roomIds || []).some(roomId => roomIds.includes(roomId)));
            const visibleStudentIds = new Set(visibleStudents.map(student => student.id));
            renderRankingList(listId, results.filter(result => visibleStudentIds.has(result.userId)), visibleStudents);
        })
        .catch(error => {
            console.error('Erro ao carregar ranking do professor:', error);
            setListEmpty(listId, 'Erro ao carregar ranking.');
        });
}

function loadGenericRanking(listId) {
    const list = setListLoading(listId, 'Carregando ranking...');
    if (!list) return Promise.resolve();
    return Promise.all([fetchCollection('userQuizzes'), fetchCollection('users')])
        .then(([results, users]) => renderRankingList(listId, results, users))
        .catch(error => {
            console.error('Erro ao carregar ranking:', error);
            setListEmpty(listId, 'Erro ao carregar ranking.');
        });
}

function renderRankingList(listId, results, users) {
    const list = document.getElementById(listId);
    if (!list) return;

    const usersMap = Object.fromEntries(users.map(user => [user.id, user]));
    const scores = {};
    results.filter(result => result.status === 'completed').forEach(result => {
        const userId = result.userId;
        if (!scores[userId]) scores[userId] = { userId, totalScore: 0, totalQuizzes: 0 };
        scores[userId].totalScore += Number(result.score || 0);
        scores[userId].totalQuizzes += 1;
    });
    const ranking = Object.values(scores).sort((a, b) => b.totalScore - a.totalScore);
    if (!ranking.length) return setListEmpty(listId, 'Nenhum resultado encontrado.');
    list.innerHTML = ranking.map((item, index) => `
        <div class="ranking-item">
            <div class="ranking-position">${index + 1}</div>
            <div class="ranking-info">
                <div class="ranking-name">${escapeHtml(usersMap[item.userId]?.name || 'Usuario')}</div>
                <div class="ranking-details">${item.totalQuizzes} quiz(es)</div>
            </div>
            <div class="ranking-score">${item.totalScore} pts</div>
        </div>
    `).join('');
}

function loadQuizRankings() {
    setListEmpty('quiz-master-list', 'Selecione um quiz para ver o ranking especifico.');
}

function loadAdminQuizRankings() {
    setListEmpty('admin-quiz-master-list', 'Selecione um quiz para ver o ranking especifico.');
}

function loadTeacherQuizRankings() {
    setListEmpty('teacher-quiz-master-list', 'Selecione um quiz para ver o ranking especifico.');
}

function loadUserHistory() {
    setListEmpty('history-list', 'Historico indisponivel nesta versao.');
}

function loadAdminReports() {
    return loadReports('admin-reports-content');
}

function loadTeacherReports() {
    const containerId = 'teacher-reports-content';
    const container = setListLoading(containerId, 'Carregando relatorios...');
    if (!container) return Promise.resolve();

    return Promise.all([getManagedRooms(), fetchUsersByType('aluno'), fetchCollection('quizzes'), fetchCollection('questions')])
        .then(([rooms, students, quizzes, questions]) => {
            const roomIds = rooms.map(room => room.id);
            const visibleStudents = students.filter(student => (student.roomIds || []).some(roomId => roomIds.includes(roomId)));
            const visibleQuizzes = quizzes.filter(quiz => quizVisibleForCurrentTeacher(quiz, roomIds));
            container.innerHTML = `
                <div class="card"><div class="card-content"><h3>${visibleStudents.length}</h3><p>Alunos</p></div></div>
                <div class="card"><div class="card-content"><h3>${rooms.length}</h3><p>Salas</p></div></div>
                <div class="card"><div class="card-content"><h3>${visibleQuizzes.length}</h3><p>Quizzes</p></div></div>
                <div class="card"><div class="card-content"><h3>${questions.length}</h3><p>Questoes</p></div></div>
            `;
        })
        .catch(error => {
            console.error('Erro ao carregar relatorios do professor:', error);
            setListEmpty(containerId, 'Erro ao carregar relatorios.');
        });
}

function loadReports(containerId) {
    const container = setListLoading(containerId, 'Carregando relatorios...');
    if (!container) return Promise.resolve();
    return Promise.all([fetchCollection('users'), fetchCollection('rooms'), fetchCollection('quizzes'), fetchCollection('questions')])
        .then(([users, rooms, quizzes, questions]) => {
            container.innerHTML = `
                <div class="card"><div class="card-content"><h3>${users.length}</h3><p>Usuarios</p></div></div>
                <div class="card"><div class="card-content"><h3>${rooms.length}</h3><p>Salas</p></div></div>
                <div class="card"><div class="card-content"><h3>${quizzes.length}</h3><p>Quizzes</p></div></div>
                <div class="card"><div class="card-content"><h3>${questions.length}</h3><p>Questoes</p></div></div>
            `;
        })
        .catch(error => {
            console.error('Erro ao carregar relatorios:', error);
            setListEmpty(containerId, 'Erro ao carregar relatorios.');
        });
}

window.openRoomModal = openRoomModal;
window.closeRoomModal = closeRoomModal;
window.saveRoom = saveRoom;
window.loadTeacherRooms = loadTeacherRooms;
window.loadAdminRooms = loadAdminRooms;
window.openTeacherQuizModal = openTeacherQuizModal;
window.closeTeacherQuizModal = closeTeacherQuizModal;
window.saveTeacherQuiz = saveTeacherQuiz;
window.loadTeacherQuizzes = loadTeacherQuizzes;
window.openTeacherUserModal = openTeacherUserModal;
window.closeTeacherUserModal = closeTeacherUserModal;
window.saveTeacherUser = saveTeacherUser;
window.loadTeacherUsers = loadTeacherUsers;
window.loadAdminUsers = loadAdminUsers;
window.openUserModal = openUserModal;
window.closeUserModal = closeUserModal;
window.saveUser = saveUser;
window.loadAdminQuizzes = loadAdminQuizzes;
window.openQuizModal = openQuizModal;
window.closeQuizModal = closeQuizModal;
window.saveQuiz = saveQuiz;
window.loadAdminQuestions = loadAdminQuestions;
window.openQuestionModal = openQuestionModal;
window.closeQuestionModal = closeQuestionModal;
window.saveQuestion = saveQuestion;
window.openImportModal = openImportModal;
window.closeImportModal = closeImportModal;
window.importQuestions = importQuestions;
window.loadQuizzes = loadQuizzes;
window.loadRanking = loadRanking;
window.loadAdminRanking = loadAdminRanking;
window.loadTeacherRanking = loadTeacherRanking;
window.loadQuizRankings = loadQuizRankings;
window.loadAdminQuizRankings = loadAdminQuizRankings;
window.loadTeacherQuizRankings = loadTeacherQuizRankings;
window.loadUserHistory = loadUserHistory;
window.loadAdminReports = loadAdminReports;
window.loadTeacherReports = loadTeacherReports;
