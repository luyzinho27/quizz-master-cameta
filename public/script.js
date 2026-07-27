// Configuração do Firebase
function resolveFirebaseConfig() {
    const candidate = window.QUIZZ_MASTER_CAMETA_FIREBASE_CONFIG;
  if (candidate && typeof candidate === 'object') {
        return candidate;
    }

    // Compatibilidade: permite que uma variavel global generica seja usada.
    const legacy = window.firebaseConfig;
    if (legacy && typeof legacy === 'object') {
        return legacy;
    }

    return null;
};

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

// A função registerUser foi removida para evitar duplicidade e erros. O fluxo de registro
// agora é tratado pelo listener de submit do formulário definido em initAuth().
//}

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
    registerForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = document.getElementById('register-name').value;
      const email = document.getElementById('register-email').value;
      const password = document.getElementById('register-password').value;
      const userType = document.getElementById('register-type').value;
  
      if (!name || !email || !password) {
        showError('register-error', 'Por favor, preencha todos os campos.');
        return;
      }
  
      // Validação de email
      if (!email.includes('@') || !email.includes('.')) {
        showError('register-error', 'E-mail inválido');
        return;
      }
  
      // Validação de senha (mínimo 8 caracteres)
      if (password.length < 8) {
        showError('register-error', 'Senha deve ter pelo menos 8 caracteres');
        return;
      }
  
      showLoading();
  
      try {
        // Criar usuário no Firebase Auth
        const userCredential = await auth.createUserWithEmailAndPassword(email, password);
        const user = userCredential.user;
  
        // Verificar se já existe um administrador, se o tipo for admin
        if (userType === 'admin') {
          const adminSnapshot = await db.collection('users').where('userType', '==', 'admin').limit(1).get();
          if (!adminSnapshot.empty) {
            throw new Error('Já existe um administrador registrado. Apenas o primeiro usuário pode ser administrador.');
          }
        }
  
        // Criar documento do usuário no Firestore
        await db.collection('users').doc(user.uid).set({
          name: name.trim(),
          email: email.toLowerCase(),
          userType: userType,
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          status: 'active',
          teacherId: userType === 'student' ? null : undefined, // só alunos têm teacherId vinculado
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
  
        // Redirecionar para login
        alert('Cadastro realizado com sucesso! Faça login com sua nova conta.');
        switchAuthTab('login');
        registerForm.reset();
        hideLoading();
      } catch (error) {
        hideLoading();
        console.error('Erro ao cadastrar usuário:', error);
        if (error.code === 'auth/email-already-in-use') {
          showError('register-error', 'Este e-mail já está em uso.');
        } else if (error.message.includes('Já existe um administrador')) {
          showError('register-error', error.message);
        } else {
          showError('register-error', getAuthErrorMessage(error));
        }
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
            const provider = new firebase.auth.GoogleAuthProvider();
            auth.signInWithPopup(provider)
                .then((result) => {
                    ensureUserDocument(result.user)
                        .then(() => {
                            showSuccess('login-success', 'Login com Google bem-sucedido!');
                            showDashboard();
                        })
                        .catch((error) => {
                            showError('login-error', getAuthErrorMessage(error));
                        });
                })
                .catch((error) => {
                    showError('login-error', getAuthErrorMessage(error));
                });
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
    const adminOption = document.getElementById('admin-option');
    if (!adminOption) return;

    // Verificar se já existe algum administrador no Firestore
    db.collection('users').where('userType', '==', 'admin').limit(1).get()
        .then(snapshot => {
            if (snapshot.empty) {
                // Nenhum administrador encontrado, habilitar opção
                adminOption.disabled = false;
                adminOption.style.opacity = '1';
                adminOption.parentElement.style.opacity = '1';
            } else {
                // Já existe um administrador, desabilitar opção
                adminOption.disabled = true;
                adminOption.style.opacity = '0.5';
                adminOption.parentElement.style.opacity = '0.5';
                adminOption.textContent = 'Administrador (somente o primeiro usuário)';
            }
        })
        .catch(error => {
            console.error('Erro ao verificar administradores:', error);
            adminOption.disabled = true;
            adminOption.style.opacity = '0.5';
            adminOption.parentElement.style.opacity = '0.5';
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

// Funcao para cadastrar usuário
function registerUser(event) {
    event.preventDefault();
    const name = document.getElementById('register-name').value;
    const email = document.getElementById('register-email').value;
    const password = document.getElementById('register-password').value;
    const userType = document.getElementById('register-type').value;

    if (!name || !email || !password) {
        showError('register-error', 'Por favor, preencha todos os campos.');
        return;
    }

    auth.createUserWithEmailAndPassword(email, password)
        .then((userCredential) => {
            // Verificar se o email já existe
            db.collection('users').where('email', '==', email).get()
                .then(querySnapshot => {
                    if (querySnapshot.empty) {
                        // Criar novo usuário se não existir
                        db.collection('users').doc(userCredential.user.uid).set({
                            name: name,
                            userType: userType,
                            status: 'active'
                        })
                        .then(() => {
                            showSuccess('register-success', 'Cadastro realizado com sucesso!');
                            switchAuthTab('login');
                        })
                        .catch((error) => {
                            showError('register-error', 'Erro ao salvar dados do usuário: ' + error.message);
                        });
                    } else {
                        showError('register-error', 'Já existe um usuário com esse e-mail');
                    }
                })
                .catch((error) => {
                    showError('register-error', 'Erro ao verificar e-mail existente: ' + error.message);
                });
        })
        .catch((error) => {
            console.log('Registro tentando:', {name, email, password, userType});
console.log('Firebase configurado:', firebase.apps.length > 0);
console.log('Registro tentando:', {name, email, password, userType});
console.log('Registro tentando:', {name, email, password, userType});
console.log('Firebase configurado:', firebase.apps.length > 0);
console.log('Registro tentando:', {name, email, password, userType});
console.log('Firebase configurado:', firebase.apps.length > 0);
showError('register-error', 'Erro ao criar conta: ' + error.code + ' - ' + error.message);
console.log('Erro de Firebase:', error);
console.log('Detalhes do erro:', error);
console.log('Erro de Firebase:', error);
        });
}

// Garantir que registerUser esteja definido antes do evento
if (!window.registerUser) { window.registerUser = registerUser; }

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

// Room management functions

function createRoom() {
  const name = document.getElementById('room-name').value.trim();
  const description = document.getElementById('room-description').value.trim();

  if (!name) {
    alert('Por favor, insira um nome para a sala.');
    return;
  }

  // Get current user's UID
  const user = firebase.auth().currentUser;
  if (!user) {
    alert('Você precisa estar logado para criar uma sala.');
    return;
  }

  // Create room in Firestore
  const roomsCol = firebase.firestore().collection('rooms');
  roomsCol.add({
    name,
    description,
    professorId: user.uid,
    students: [],
    quizzes: [],
    createdAt: new Date()
  })
  .then(() => {
    document.getElementById('room-name').value = '';
    document.getElementById('room-description').value = '';
    fetchRooms();n  })
  .catch((error) => {
    console.error('Error creating room:', error);
    alert('Erro ao criar sala: ' + error.message);
  });
}

// Fetch rooms from Firestore and display in UI
function fetchRooms() {
  const user = firebase.auth().currentUser;
  if (!user) return;

  const roomsList = document.getElementById('rooms');
  roomsList.innerHTML = '';

  firebase.firestore().collection('rooms').where('professorId', '==', user.uid)
    .get()
    .then((querySnapshot) => {
      if (querySnapshot.empty) {
        const li = document.createElement('li');
        li.textContent = 'Nenhuma sala encontrada.';
        roomsList.appendChild(li);
        return;
      }

      querySnapshot.forEach((doc) => {
        const room = doc.data();
        const li = document.createElement('li');
        li.innerHTML = 
          `<strong>${room.name}</strong><br>
          ${room.description || 'Sem descrição'}
          <button onclick="editRoom('${doc.id}')">Editar</button>
          <button onclick="deleteRoom('${doc.id}')">Excluir</button>`;
        roomsList.appendChild(li);
      });
    })
    .catch((error) => {
      console.error('Error fetching rooms:', error);
      alert('Erro ao carregar salas: ' + error.message);
    });
}

// Initialize room list when page loads
window.addEventListener('DOMContentLoaded', () => {
  fetchRooms();
});

function editRoom(roomId) {
  // Implement edit room functionality
  const newName = prompt('Digite o novo nome da sala:');
  const newDescription = prompt('Digite uma nova descrição para a sala:');

  if (!newName && !newDescription) return;

  const updateData = {};
  if (newName) updateData.name = newName.trim();
  if (newDescription) updateData.description = newDescription.trim();

  db.collection('rooms').doc(roomId).update(updateData)
    .then(() => {
      alert('Sala atualizada com sucesso!');
      fetchRooms();
    })
    .catch((error) => {
      console.error('Erro ao atualizar sala:', error);
      alert('Erro ao atualizar sala: ' + error.message);
    });
}

function deleteRoom(roomId) {
  if (confirm('Tem certeza que deseja excluir esta sala?')) {
    db.collection('rooms').doc(roomId).delete()
      .then(() => {
        alert('Sala excluída com sucesso!');
        fetchRooms();
      })
      .catch((error) => {
        console.error('Erro ao excluir sala:', error);
        alert('Erro ao excluir sala: ' + error.message);
      });
  }
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

// Quiz creation functions

// The room and quiz creation logic that depended on the removed Rooms module has been
// removed. If room management is required, a new implementation should be added.

// Function to add student to room
// Room management functionality has been removed. If needed, reimplement here.
