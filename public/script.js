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
    const message = 'Configuração do Firebase ausente. Crie public/config.js a partir de public/config.example.js.';
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
let editingUserProfileMode = false;
let pendingQuizLinkStarted = false;

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
        console.warn('Não foi possível salvar o estado do quiz localmente:', error);
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
        console.warn('Não foi possível ler o estado do quiz localmente:', error);
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
        console.warn('Não foi possível ler o estado do quiz localmente:', error);
        return null;
    }
}

function clearQuizStateLocal(userId, quizId) {
    if (!userId || !quizId) return;
    try {
        localStorage.removeItem(getQuizStateKey(userId, quizId));
    } catch (error) {
        console.warn('Não foi possível limpar o estado do quiz localmente:', error);
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

function formatSeconds(seconds) {
    const safeSeconds = Math.max(0, Number(seconds) || 0);
    const minutes = Math.floor(safeSeconds / 60);
    const remainingSeconds = safeSeconds % 60;
    return `${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
}

function shuffleItems(items) {
    const copy = [...items];
    for (let index = copy.length - 1; index > 0; index--) {
        const randomIndex = Math.floor(Math.random() * (index + 1));
        [copy[index], copy[randomIndex]] = [copy[randomIndex], copy[index]];
    }
    return copy;
}

function getQuizLinkId() {
    try {
        const params = new URLSearchParams(window.location.search);
        return params.get('quiz') || params.get('q') || params.get('quizId') || params.get('id') || '';
    } catch (error) {
        return '';
    }
}

function clearQuizLinkIdFromUrl() {
    try {
        const url = new URL(window.location.href);
        url.searchParams.delete('quiz');
        url.searchParams.delete('q');
        window.history.replaceState({}, document.title, url.toString());
    } catch (error) {
        console.warn('Não foi possível limpar o link do quiz da URL:', error);
    }
}

function getQuizAccessLink(quizId) {
    const url = new URL(window.location.href);
    url.searchParams.set('quiz', quizId);
    return url.toString();
}

function copyQuizLink(quizId) {
    const link = getQuizAccessLink(quizId);
    const notify = () => alert(`Link copiado. Código do quiz: ${quizId}`);

    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(link).then(notify).catch(() => {
            window.prompt('Copie o link do quiz:', link);
        });
        return;
    }

    window.prompt('Copie o link do quiz:', link);
}

function studentCanAccessQuiz(quiz, rooms = []) {
    if (!currentUser || currentUser.userType !== 'aluno' || !quiz || quiz.status !== 'active') return false;
    if (quiz.visibility === 'specific') return (quiz.allowedStudents || []).includes(currentUser.uid);
    if (quiz.visibility === 'room') {
        const roomIds = rooms.map(room => room.id);
        return Boolean(quiz.roomId && roomIds.includes(quiz.roomId));
    }
    return !quiz.visibility || quiz.visibility === 'all';
}

function getAttemptTimestamp(attempt) {
    return getTimestampMs(attempt.completedAt) ||
        getTimestampMs(attempt.updatedAt) ||
        getTimestampMs(attempt.startTime) ||
        0;
}

function getStudentQuizAttempts(quizId = null) {
    if (!currentUser || currentUser.userType !== 'aluno') return Promise.resolve([]);
    let query = db.collection('userQuizzes').where('userId', '==', currentUser.uid);
    if (quizId) query = query.where('quizId', '==', quizId);
    return fetchQuery(query);
}

function getLatestAttempt(attempts, status = null) {
    return attempts
        .filter(attempt => !status || attempt.status === status)
        .sort((a, b) => getAttemptTimestamp(b) - getAttemptTimestamp(a))[0] || null;
}

function mapAttemptsByQuiz(attempts) {
    return attempts.reduce((map, attempt) => {
        const quizId = attempt.quizId;
        if (!quizId) return map;
        if (!map[quizId]) map[quizId] = [];
        map[quizId].push(attempt);
        return map;
    }, {});
}

function getVisibleStudentQuizzes() {
    if (!currentUser || currentUser.userType !== 'aluno') return Promise.resolve([]);
    return Promise.all([fetchCollectionWhere('quizzes', 'status', '==', 'active'), fetchStudentRooms()])
        .then(([quizzes, rooms]) => quizzes.filter(quiz => studentCanAccessQuiz(quiz, rooms)));
}

function resumeQuizFromAttempt(quiz, attempt) {
    currentQuiz = quiz;
    userQuizId = attempt.id;
    currentQuestionIndex = Number(attempt.currentQuestionIndex || 0);
    userAnswers = Array.isArray(attempt.answers) ? attempt.answers : [];
    exitCount = Number(attempt.exitCount || 0);
    totalTime = Math.max(60, Number(attempt.totalTime) || ((Number(quiz.time) || 0) * 60));
    timeRemaining = typeof attempt.timeRemaining === 'number' ? Math.max(0, attempt.timeRemaining) : totalTime;
    quizStartTime = Date.now();

    return loadQuizQuestions(quiz.id, {
        questionIds: attempt.questionIds || [],
        preserveAnswers: true,
        resume: true
    });
}

function updateUserQuizProgress() {
    if (!currentUser || !currentQuiz || !userQuizId) return Promise.resolve();

    const progress = {
        status: 'in-progress',
        answers: normalizeAnswers(userAnswers, currentQuestions.length),
        currentQuestionIndex,
        timeRemaining,
        exitCount,
        questionIds: currentQuestions.map(question => question.id).filter(Boolean),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };

    saveQuizStateLocal({ active: quizActive });
    return db.collection('userQuizzes').doc(userQuizId).set(progress, { merge: true })
        .catch(error => console.error('Erro ao salvar progresso do quiz:', error));
}

function stopQuizTimer() {
    if (quizTimer) {
        clearInterval(quizTimer);
        quizTimer = null;
    }
}

function updateTimerDisplay() {
    setText('quiz-timer', formatSeconds(timeRemaining));
    const timerProgress = document.getElementById('timer-progress');
    if (timerProgress) {
        const ratio = totalTime ? Math.max(0, Math.min(1, timeRemaining / totalTime)) : 0;
        timerProgress.style.strokeDashoffset = String(175 - (175 * ratio));
    }
}

function startQuizTimer() {
    stopQuizTimer();
    updateTimerDisplay();
    quizTimer = setInterval(() => {
        timeRemaining = Math.max(0, timeRemaining - 1);
        updateTimerDisplay();
        syncQuizProgress();
        if (timeRemaining <= 0) {
            finishQuiz({ forced: true });
        }
    }, 1000);
}

function showQuizScreen() {
    hideDashboard();
    quizResult.classList.add('hidden');
    quizContainer.classList.remove('hidden');
}

function fetchQuestionsForQuiz(quiz, questionIds = []) {
    if (questionIds.length) {
        return Promise.all(questionIds.map(id => db.collection('questions').doc(id).get()))
            .then(docs => docs.filter(doc => doc.exists).map(doc => ({ id: doc.id, ...doc.data() })));
    }

    const query = quiz.category
        ? db.collection('questions').where('category', '==', quiz.category)
        : db.collection('questions');

    return fetchQuery(query).then(questions => {
        const requestedCount = Math.max(1, Number(quiz.questionsCount) || questions.length);
        return shuffleItems(questions).slice(0, requestedCount);
    });
}

function loadQuizQuestions(quizId, options = {}) {
    const quizRequest = currentQuiz && currentQuiz.id === quizId
        ? Promise.resolve(currentQuiz)
        : db.collection('quizzes').doc(quizId).get().then(doc => {
            if (!doc.exists) throw new Error('Quiz não encontrado.');
            return { id: doc.id, ...doc.data() };
        });

    return quizRequest.then(quiz => {
        currentQuiz = quiz;
        return fetchQuestionsForQuiz(quiz, options.questionIds || []).then(questions => {
            if (!questions.length) throw new Error('Nenhuma questão encontrada para este quiz.');

            currentQuestions = questions;
            userAnswers = normalizeAnswers(options.preserveAnswers ? userAnswers : [], currentQuestions.length);
            currentQuestionIndex = Math.min(currentQuestionIndex, currentQuestions.length - 1);
            totalTime = Math.max(60, (Number(quiz.time) || 0) * 60);
            if (!options.resume) {
                timeRemaining = totalTime;
            } else if (typeof timeRemaining !== 'number') {
                timeRemaining = totalTime;
            }

            setText('quiz-title-display', quiz.title || 'Quiz');
            setText('quiz-description-display', quiz.description || '');
            showQuizScreen();
            displayQuestion();
            startQuizTimer();
            setQuizActive(true);
            return true;
        });
    });
}

function startQuiz(quizId, options = {}) {
    if (!currentUser || currentUser.userType !== 'aluno') {
        alert('Apenas alunos podem iniciar quizzes.');
        return Promise.resolve(false);
    }

    showLoading();
    return Promise.all([
        db.collection('quizzes').doc(quizId).get(),
        fetchStudentRooms(),
        getStudentQuizAttempts(quizId)
    ]).then(([quizDoc, rooms, attempts]) => {
        if (!quizDoc.exists) throw new Error('Quiz não encontrado.');
        const quiz = { id: quizDoc.id, ...quizDoc.data() };
        if (!studentCanAccessQuiz(quiz, rooms)) {
            throw new Error('Este quiz não está disponível para sua conta.');
        }

        const completedAttempt = getLatestAttempt(attempts, 'completed');
        if (completedAttempt) {
            throw new Error('Você já concluiu este quiz. A tentativa ficou bloqueada para nova realização.');
        }

        const inProgressAttempt = getLatestAttempt(attempts, 'in-progress');
        if (inProgressAttempt) {
            return resumeQuizFromAttempt(quiz, inProgressAttempt).then(resumed => {
                hideLoading();
                if (options.fromLink) clearQuizLinkIdFromUrl();
                return resumed;
            });
        }

        currentQuiz = quiz;
        currentQuestions = [];
        currentQuestionIndex = 0;
        userAnswers = [];
        exitCount = 0;
        totalTime = Math.max(60, (Number(quiz.time) || 0) * 60);
        timeRemaining = totalTime;
        quizStartTime = Date.now();

        return fetchQuestionsForQuiz(quiz).then(questions => {
            if (!questions.length) throw new Error('Nenhuma questão encontrada para este quiz.');

            currentQuestions = questions;
            userAnswers = normalizeAnswers([], currentQuestions.length);
            const attempt = {
                userId: currentUser.uid,
                userName: currentUser.name || currentUser.email || 'Aluno',
                quizId: quiz.id,
                quizTitle: quiz.title || 'Quiz',
                roomId: quiz.roomId || null,
                status: 'in-progress',
                answers: userAnswers,
                questionIds: currentQuestions.map(question => question.id).filter(Boolean),
                currentQuestionIndex: 0,
                timeRemaining,
                totalTime,
                exitCount,
                score: 0,
                startTime: firebase.firestore.FieldValue.serverTimestamp(),
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            };

            return db.collection('userQuizzes').add(attempt);
        }).then(docRef => {
            userQuizId = docRef.id;
            hideLoading();
            if (options.fromLink) clearQuizLinkIdFromUrl();
            setText('quiz-title-display', quiz.title || 'Quiz');
            setText('quiz-description-display', quiz.description || '');
            showQuizScreen();
            displayQuestion();
            startQuizTimer();
            setQuizActive(true);
            return true;
        });
    }).catch(error => {
        hideLoading();
        console.error('Erro ao iniciar quiz:', error);
        alert('Erro ao iniciar quiz: ' + getAuthErrorMessage(error));
        return false;
    });
}

function displayQuestion() {
    if (!currentQuestions.length) return;
    const question = currentQuestions[currentQuestionIndex];
    setText('question-text', question.text || 'Questão sem enunciado.');
    setText('option-a-text', question.options?.a || '');
    setText('option-b-text', question.options?.b || '');
    setText('option-c-text', question.options?.c || '');
    setText('option-d-text', question.options?.d || '');
    setText('current-question', String(currentQuestionIndex + 1));
    setText('total-questions', String(currentQuestions.length));
    setText('quiz-progress-text', `Questão ${currentQuestionIndex + 1}/${currentQuestions.length}`);

    const progressFill = document.getElementById('progress-fill');
    if (progressFill) {
        progressFill.style.width = `${((currentQuestionIndex + 1) / currentQuestions.length) * 100}%`;
    }

    document.querySelectorAll('#options-container .option').forEach(option => {
        option.classList.toggle('selected', option.dataset.value === userAnswers[currentQuestionIndex]);
    });

    const previousButton = document.getElementById('prev-question');
    const nextButton = document.getElementById('next-question');
    const finishButton = document.getElementById('finish-quiz');
    if (previousButton) previousButton.disabled = currentQuestionIndex === 0;
    if (nextButton) nextButton.classList.toggle('hidden', currentQuestionIndex >= currentQuestions.length - 1);
    if (finishButton) finishButton.classList.toggle('hidden', currentQuestionIndex < currentQuestions.length - 1);

    saveQuizStateLocal({ active: true });
}

function selectAnswer(answer) {
    if (!currentQuestions.length || !['a', 'b', 'c', 'd'].includes(answer)) return;
    userAnswers[currentQuestionIndex] = answer;
    displayQuestion();
    syncQuizProgress(true);
}

function showQuizResult(result) {
    hideDashboard();
    quizContainer.classList.add('hidden');
    quizResult.classList.remove('hidden');
    setText('score-percentage', `${result.percentage}%`);
    setText('score-fraction', `${result.correct}/${result.total}`);
    setText('correct-answers', String(result.correct));
    setText('wrong-answers', String(result.wrong));
    setText('time-taken', formatSeconds(result.timeTaken));
    setText('ranking-position', '-');

    const reviewButton = document.getElementById('review-quiz');
    if (reviewButton) reviewButton.classList.toggle('hidden', currentQuiz && currentQuiz.allowReview === false);
}

function updateResultRankingPosition(quizId, userId) {
    if (!quizId || !userId) return Promise.resolve();
    return fetchQuery(db.collection('userQuizzes')
        .where('quizId', '==', quizId)
        .where('status', '==', 'completed'))
        .then(results => {
            const ordered = results
                .sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || Number(a.timeTaken || 0) - Number(b.timeTaken || 0));
            const position = ordered.findIndex(result => result.userId === userId);
            setText('ranking-position', position >= 0 ? `${position + 1}º` : '-');
        })
        .catch(error => console.error('Erro ao calcular posição no ranking:', error));
}

function finishQuiz(options = {}) {
    if (!currentQuiz || !currentQuestions.length || !userQuizId) return Promise.resolve(false);
    const unansweredCount = userAnswers.filter(answer => !answer).length;
    if (!options.forced && unansweredCount > 0 && !confirm(`Você ainda tem ${unansweredCount} questão(ões) sem resposta. Deseja finalizar mesmo assim?`)) {
        return Promise.resolve(false);
    }

    stopQuizTimer();
    const normalizedAnswers = normalizeAnswers(userAnswers, currentQuestions.length);
    const correct = currentQuestions.reduce((total, question, index) => {
        return total + (normalizedAnswers[index] === question.correctAnswer ? 1 : 0);
    }, 0);
    const total = currentQuestions.length;
    const wrong = total - correct;
    const percentage = total ? Math.round((correct / total) * 100) : 0;
    const timeTaken = Math.max(0, totalTime - timeRemaining);
    const result = { correct, wrong, total, percentage, timeTaken };

    const payload = {
        status: 'completed',
        answers: normalizedAnswers,
        currentQuestionIndex,
        questionIds: currentQuestions.map(question => question.id).filter(Boolean),
        score: percentage,
        userName: currentUser.name || currentUser.email || 'Aluno',
        correctAnswers: correct,
        wrongAnswers: wrong,
        totalQuestions: total,
        timeTaken,
        exitCount,
        exitLimitReached: Boolean(options.exitLimit),
        finishReason: options.exitLimit ? 'exit-limit' : 'completed',
        completedAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };

    return db.collection('userQuizzes').doc(userQuizId).set(payload, { merge: true })
        .then(() => {
            setQuizActive(false, { clearLocal: true, persist: false });
            showQuizResult(result);
            updateResultRankingPosition(currentQuiz.id, currentUser.uid);
            return true;
        })
        .catch(error => {
            console.error('Erro ao finalizar quiz:', error);
            alert('Erro ao finalizar quiz: ' + getAuthErrorMessage(error));
            startQuizTimer();
            return false;
        });
}

function handleReviewClick() {
    if (!currentQuestions.length) return alert('Nenhuma revisão disponível.');
    if (currentQuiz && currentQuiz.allowReview === false) return alert('A revisão deste quiz não está disponível.');

    const content = document.getElementById('review-content');
    if (!content) return;
    content.innerHTML = currentQuestions.map((question, index) => {
        const userAnswer = userAnswers[index] || '-';
        const correctAnswer = question.correctAnswer || '-';
        const isCorrect = userAnswer === correctAnswer;
        return `
            <div class="card">
                <div class="card-header">
                    <h3 class="card-title">Questão ${index + 1}</h3>
                    <span class="card-badge ${isCorrect ? '' : 'card-badge-secondary'}">${isCorrect ? 'Correta' : 'Incorreta'}</span>
                </div>
                <div class="card-content">
                    <p>${escapeHtml(question.text || '')}</p>
                    <p><strong>Sua resposta:</strong> ${escapeHtml(userAnswer.toUpperCase())}</p>
                    <p><strong>Resposta correta:</strong> ${escapeHtml(correctAnswer.toUpperCase())}</p>
                </div>
            </div>
        `;
    }).join('');

    document.getElementById('review-modal').classList.remove('hidden');
}

function closeReviewModal() {
    document.getElementById('review-modal').classList.add('hidden');
}

function attemptStartQuizFromLink() {
    const quizId = getQuizLinkId();
    if (!quizId || pendingQuizLinkStarted || !currentUser || currentUser.userType !== 'aluno') {
        return Promise.resolve(false);
    }

    pendingQuizLinkStarted = true;
    // Ensure the student is added to the room associated with the quiz, if any.
    return db.collection('quizzes').doc(quizId).get()
        .then(doc => {
            if (!doc.exists) throw new Error('Quiz não encontrado.');
            const quiz = { id: doc.id, ...doc.data() };
            if (!quiz.roomId) return Promise.resolve();
            return db.runTransaction(async transaction => {
                const roomRef = db.collection('rooms').doc(quiz.roomId);
                const roomDoc = await transaction.get(roomRef);
                if (!roomDoc.exists) return;
                const roomData = roomDoc.data();
                const studentIds = Array.isArray(roomData.studentIds) ? roomData.studentIds : [];
                if (!studentIds.includes(currentUser.uid)) {
                    transaction.update(roomRef, {
                        studentIds: firebase.firestore.FieldValue.arrayUnion(currentUser.uid)
                    });
                }
            });
        })
        .then(() => startQuiz(quizId, { fromLink: true }))
        .then(started => {
            if (!started) pendingQuizLinkStarted = false;
            return started;
        })
        .catch(error => {
            console.error('Erro ao iniciar quiz via link:', error);
            pendingQuizLinkStarted = false;
            return false;
        });
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
                // Se houver um link de quiz na URL, iniciar automaticamente
                attemptStartQuizFromLink();
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
                adminOption.textContent = 'Administrador (verificação indisponível)';
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
    const confirmMsg = 'Tem certeza que deseja sair do quiz? Seu progresso será salvo para continuar depois.';
    if (!confirm(confirmMsg)) {
        return;
    }

    exitCount += 1;

    if (exitCount >= 3) {
        alert('Você saiu deste quiz 3 vezes. A tentativa será finalizada com as respostas feitas até agora.');
        finishQuiz({ forced: true, exitLimit: true });
        return;
    }

    stopQuizTimer();
    updateUserQuizProgress(true).finally(() => {
        setQuizActive(false);
        quizContainer.classList.add('hidden');
        showDashboard();
        alert(`Progresso salvo. Você ainda pode sair ${3 - exitCount} vez(es) antes da finalização automática.`);
    });

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
        'auth/invalid-email': 'E-mail inválido.',
        'auth/user-disabled': 'Esta conta foi desativada.',
        'auth/user-not-found': 'Nenhuma conta encontrada com este e-mail.',
        'auth/wrong-password': 'Senha incorreta.',
        'auth/invalid-credential': 'E-mail ou senha inválidos.',
        'auth/email-already-in-use': 'Este e-mail ja esta em uso.',
        'auth/weak-password': 'A senha deve ter pelo menos 6 caracteres.',
        'auth/operation-not-allowed': 'Método de login não habilitado no Firebase Authentication.',
        'auth/unauthorized-domain': 'Domínio não autorizado no Firebase Authentication.',
        'auth/popup-blocked': 'O popup do Google foi bloqueado. Autorize popups ou tente novamente.',
        'auth/popup-closed-by-user': 'Login com Google cancelado.',
        'auth/cancelled-popup-request': 'Ja existe uma tentativa de login com Google em andamento.',
        'auth/account-exists-with-different-credential': 'Ja existe uma conta com este e-mail usando outro metodo de login.',
        'auth/network-request-failed': 'Erro de rede. Verifique sua conexao e tente novamente.',
        'permission-denied': 'Login autenticado, mas sem permissão para acessar os dados do usuário no Firestore.',
        'unavailable': 'Serviço temporariamente indisponível. Tente novamente em instantes.'
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
        return Promise.reject(new Error('Usuário autenticado inválido.'));
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
            console.error('Erro ao registrar usuário:', error);
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

    console.warn(`Função indisponível: ${functionName}`);
    return null;
}

function initEventListeners() {
    safeOn('student-logout', 'click', logout);
    safeOn('admin-logout', 'click', logout);
    safeOn('teacher-logout', 'click', logout);
    safeOn('admin-account-menu-toggle', 'click', event => toggleAccountMenu('admin', event));
    safeOn('teacher-account-menu-toggle', 'click', event => toggleAccountMenu('teacher', event));
    safeOn('admin-profile-btn', 'click', () => openCurrentUserProfile());
    safeOn('teacher-profile-btn', 'click', () => openCurrentUserProfile());
    document.addEventListener('click', closeAccountMenus);

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
    safeOn('quiz-master-select', 'change', () => loadSelectedQuizRanking('student', 'quiz-master-select', 'quiz-master-list'));
    safeOn('admin-quiz-master-select', 'change', () => loadSelectedQuizRanking('admin', 'admin-quiz-master-select', 'admin-quiz-master-list'));

    safeOn('create-quiz-btn', 'click', () => invokeIfAvailable('openQuizModal'));
    safeOn('create-question-btn', 'click', () => invokeIfAvailable('openQuestionModal'));
    safeOn('import-questions-btn', 'click', () => invokeIfAvailable('openImportModal'));
    safeOn('create-user-btn', 'click', () => invokeIfAvailable('openUserModal'));

    safeOn('create-room-btn', 'click', () => invokeIfAvailable('openRoomModal'));
    safeOn('admin-create-room-btn', 'click', () => invokeIfAvailable('openRoomModal'));
    safeOn('teacher-create-quiz-btn', 'click', () => invokeIfAvailable('openTeacherQuizModal'));
    safeOn('teacher-create-question-btn', 'click', () => invokeIfAvailable('openQuestionModal'));
    safeOn('teacher-import-questions-btn', 'click', () => invokeIfAvailable('openImportModal'));
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
    safeOn('teacher-questions-tab', 'click', () => {
        switchTeacherTab('teacher-questions-tab', 'teacher-questions-section');
        invokeIfAvailable('loadTeacherQuestions');
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
    document.querySelectorAll('#options-container .option').forEach(option => {
        option.addEventListener('click', () => selectAnswer(option.dataset.value));
    });

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

function resourceOwnedByCurrentUser(resource) {
    return Boolean(currentUser && resource && (
        resource.ownerId === currentUser.uid ||
        resource.teacherId === currentUser.uid
    ));
}

function canEditOwnedResource(resource) {
    return canManageTeacherResources() && resourceOwnedByCurrentUser(resource);
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

function fetchOwnedQuizzesForCurrentUser() {
    if (!currentUser) return Promise.resolve([]);
    return Promise.all([
        fetchCollectionWhere('quizzes', 'ownerId', '==', currentUser.uid),
        fetchCollectionWhere('quizzes', 'teacherId', '==', currentUser.uid)
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
        return Promise.reject(new Error('Informe uma senha temporária com pelo menos 6 caracteres.'));
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
        // Primeiro tenta iniciar o quiz via link. Se não houver link ou o
        // aluno já estiver em uma sala, apenas carrega a lista de quizzes.
        attemptStartQuizFromLink().then(started => {
            if (!started) {
                loadQuizzes();
            }
        });
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

function closeAccountMenus() {
    ['admin', 'teacher'].forEach(role => {
        const menu = document.getElementById(`${role}-account-menu`);
        const toggle = document.getElementById(`${role}-account-menu-toggle`);
        if (menu) menu.classList.add('hidden');
        if (toggle) toggle.setAttribute('aria-expanded', 'false');
    });
}

function toggleAccountMenu(role, event) {
    if (event) event.stopPropagation();
    const menu = document.getElementById(`${role}-account-menu`);
    const toggle = document.getElementById(`${role}-account-menu-toggle`);
    if (!menu || !toggle) return;

    const willOpen = menu.classList.contains('hidden');
    closeAccountMenus();
    if (willOpen) {
        menu.classList.remove('hidden');
        toggle.setAttribute('aria-expanded', 'true');
    }
}

function openCurrentUserProfile() {
    closeAccountMenus();
    if (!currentUser || !currentUser.uid) return alert('Usuário autenticado inválido.');

    if (isAdminUser()) {
        return openUserModal(currentUser.uid, { profileMode: true });
    }

    if (isTeacherUser()) {
        return openTeacherUserModal(currentUser.uid, { profileMode: true });
    }

    return null;
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
            if (!doc.exists) throw new Error('Sala não encontrada.');
            const room = { id: doc.id, ...doc.data() };
            if (!canEditRoom(room)) throw new Error('Você só pode editar salas criadas por você.');
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
        ? db.collection('rooms').doc(editingRoomId).get().then(doc => {
            if (!doc.exists) throw new Error('Sala não encontrada.');
            const room = { id: doc.id, ...doc.data() };
            if (!canEditRoom(room)) throw new Error('Você só pode editar salas criadas por você.');
            return db.collection('rooms').doc(editingRoomId).set(roomData, { merge: true });
        })
        : db.collection('rooms').add({ ...roomData, createdAt: firebase.firestore.FieldValue.serverTimestamp() });

    request.then(() => {
        alert('Sala salva com sucesso!');
        closeRoomModal();
        isAdminUser() ? loadAdminRooms() : loadTeacherRooms();
    }).catch(error => alert('Erro ao salvar sala: ' + getAuthErrorMessage(error)));
}

function roomVisibleForCurrentUser(room) {
    return isAdminUser() || resourceOwnedByCurrentUser(room);
}

function canEditRoom(room) {
    return canEditOwnedResource(room);
}

function getOwnedRooms() {
    if (canManageTeacherResources()) {
        return fetchManagedRoomsForTeacher().then(rooms => firebaseOrderByCreatedDesc(rooms.filter(resourceOwnedByCurrentUser)));
    }

    return Promise.resolve([]);
}

function getManagedRooms() {
    return getOwnedRooms();
}

function getVisibleRoomsForDashboard() {
    if (isAdminUser()) {
        return fetchCollection('rooms').then(rooms => firebaseOrderByCreatedDesc(rooms));
    }

    return getOwnedRooms();
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
                <p>${escapeHtml(room.description || 'Sem descrição')}</p>
                <p><strong>Alunos:</strong> ${(room.studentIds || []).length}</p>
                <p><strong>Responsável:</strong> ${escapeHtml(room.teacherName || room.ownerName || 'N/A')}</p>
                <p><strong>Criada em:</strong> ${formatDate(room.createdAt)}</p>
            </div>
            <div class="card-actions">
                ${canEditRoom(room) ? `<button class="btn btn-primary room-edit" data-id="${escapeHtml(room.id)}"><i class="fas fa-edit"></i><span class="btn-text">Editar</span></button>` : ''}
                ${canEditRoom(room) ? `<button class="btn btn-danger room-delete" data-id="${escapeHtml(room.id)}"><i class="fas fa-trash"></i><span class="btn-text">Excluir</span></button>` : ''}
                ${!canEditRoom(room) ? '<span class="card-badge card-badge-secondary">Somente visualização</span>' : ''}
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
    return getVisibleRoomsForDashboard()
        .then(rooms => renderRooms('admin-rooms-list', rooms))
        .catch(error => {
            console.error('Erro ao carregar salas:', error);
            setListEmpty('admin-rooms-list', 'Erro ao carregar salas.');
        });
}

function deleteRoom(roomId) {
    return db.collection('rooms').doc(roomId).get()
        .then(doc => {
            if (!doc.exists) throw new Error('Sala não encontrada.');
            const room = { id: doc.id, ...doc.data() };
            if (!canEditRoom(room)) throw new Error('Você só pode excluir salas criadas por você.');
            if (!confirm('Tem certeza que deseja excluir esta sala?')) return false;
            return db.collection('rooms').doc(roomId).delete();
        })
        .then(deleted => {
            if (deleted === false) return;
            alert('Sala excluída com sucesso!');
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
                if (!doc.exists) throw new Error('Quiz não encontrado.');
                const quiz = { id: doc.id, ...doc.data() };
                if (!canEditQuiz(quiz)) throw new Error('Você só pode editar quizzes criados por você.');
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
        return alert('Preencha título, categoria, sala, número de questões e tempo.');
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
        ? db.collection('quizzes').doc(editingTeacherQuizId).get().then(doc => {
            if (!doc.exists) throw new Error('Quiz não encontrado.');
            const quiz = { id: doc.id, ...doc.data() };
            if (!canEditQuiz(quiz)) throw new Error('Você só pode editar quizzes criados por você.');
            return db.collection('quizzes').doc(editingTeacherQuizId).set(quizData, { merge: true });
        })
        : db.collection('quizzes').add({ ...quizData, createdAt: firebase.firestore.FieldValue.serverTimestamp() });

    request.then(() => {
        alert('Quiz salvo com sucesso!');
        closeTeacherQuizModal();
        isAdminUser() ? loadAdminQuizzes() : loadTeacherQuizzes();
    }).catch(error => alert('Erro ao salvar quiz: ' + getAuthErrorMessage(error)));
}

function quizVisibleForCurrentTeacher(quiz, roomIds = []) {
    if (!currentUser || !quiz) return false;
    const isOwnQuiz = quiz.teacherId === currentUser.uid || quiz.ownerId === currentUser.uid;
    const isOwnRoomQuiz = quiz.roomId && roomIds.includes(quiz.roomId);
    if (quiz.visibility === 'room' || quiz.roomId) return isOwnQuiz || isOwnRoomQuiz;
    return isAdminUser();
}

function canEditQuiz(quiz) {
    return canEditOwnedResource(quiz);
}

function canDeleteQuiz(quiz) {
    return canEditOwnedResource(quiz);
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
                <p>${escapeHtml(quiz.description || 'Sem descrição')}</p>
                <p><strong>Categoria:</strong> ${escapeHtml(quiz.category || 'Geral')}</p>
                <p><strong>Sala:</strong> ${escapeHtml(roomsMap[quiz.roomId]?.name || 'Sem sala')}</p>
                <p><strong>Questões:</strong> ${quiz.questionsCount || 0}</p>
                <p><strong>Tempo:</strong> ${quiz.time || 0} minutos</p>
            </div>
            <div class="card-actions">
                ${canEditQuiz(quiz) ? `<button class="btn btn-primary teacher-quiz-edit" data-id="${escapeHtml(quiz.id)}"><i class="fas fa-edit"></i><span class="btn-text">Editar</span></button>` : ''}
                <button class="btn btn-secondary teacher-quiz-link" data-id="${escapeHtml(quiz.id)}"><i class="fas fa-link"></i><span class="btn-text">Link</span></button>
                ${canDeleteQuiz(quiz) ? `<button class="btn btn-danger teacher-quiz-delete" data-id="${escapeHtml(quiz.id)}"><i class="fas fa-trash"></i><span class="btn-text">Excluir</span></button>` : ''}
                ${!canEditQuiz(quiz) ? '<span class="card-badge card-badge-secondary">Somente visualização</span>' : ''}
            </div>
        </div>
    `).join('');

    addClickHandler(`#${listId} .teacher-quiz-edit`, event => openTeacherQuizModal(event.currentTarget.dataset.id));
    addClickHandler(`#${listId} .teacher-quiz-link`, event => copyQuizLink(event.currentTarget.dataset.id));
    addClickHandler(`#${listId} .teacher-quiz-delete`, event => deleteQuiz(event.currentTarget.dataset.id, () => {
        isAdminUser() ? loadAdminQuizzes() : loadTeacherQuizzes();
    }));
}

function loadTeacherQuizzes() {
    setListLoading('teacher-quizzes-list', 'Carregando quizzes...');
    return Promise.all([getManagedRooms(), fetchOwnedQuizzesForCurrentUser()])
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

function openTeacherUserModal(userId = null, options = {}) {
    if (!canManageTeacherResources()) return alert('Acesso negado.');
    editingTeacherUserId = userId;
    editingTeacherTargetUserType = 'aluno';
    const profileMode = Boolean(options.profileMode);
    setText('teacher-user-modal-title', profileMode ? 'Editar Perfil' : userId ? 'Editar Usuário' : 'Cadastrar Aluno');
    ['teacher-user-name', 'teacher-user-email', 'teacher-user-password'].forEach(id => setValue(id, ''));
    setValue('teacher-user-status', 'active');

    return Promise.all([
        getManagedRooms(),
        userId ? db.collection('users').doc(userId).get() : Promise.resolve(null)
    ]).then(([rooms, userDoc]) => {
        let selectedRoomIds = [];
        if (userDoc && userDoc.exists) {
            const user = userDoc.data();
            if (isTeacherUser() && userId !== currentUser.uid && user.userType !== 'aluno') {
                throw new Error('Acesso negado a este usuário.');
            }

            editingTeacherTargetUserType = user.userType || 'aluno';
            const isOwnProfile = isTeacherUser() && userId === currentUser.uid;
            setText('teacher-user-modal-title', isOwnProfile ? 'Editar Perfil' : 'Editar Aluno');
            setValue('teacher-user-name', user.name || '');
            setValue('teacher-user-email', user.email || '');
            setValue('teacher-user-status', user.status || 'active');
            selectedRoomIds = user.roomIds || [];
        }

        const roomList = document.getElementById('teacher-user-rooms-list');
        const isOwnProfile = isTeacherUser() && userId === currentUser.uid;
        roomList.innerHTML = isOwnProfile
            ? '<p>Seu usuário de professor não é vinculado a salas como aluno.</p>'
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
        }).catch(error => alert('Erro ao atualizar usuário: ' + getAuthErrorMessage(error)));
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
    return fetchUsersByType('aluno')
        .then(users => {
            teacherUsersCache = users.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'pt-BR'));
            renderUsers('teacher-users-list', teacherUsersCache, { teacherMode: true, allowDelete: isAdminUser() });
        })
        .catch(error => {
            console.error('Erro ao carregar alunos:', error);
            setListEmpty('teacher-users-list', 'Erro ao carregar alunos.');
        });
}

function renderUsers(listId, users, options = {}) {
    const list = document.getElementById(listId);
    if (!list) return;
    if (!users.length) return setListEmpty(listId, 'Nenhum usuário encontrado.');
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
    setListLoading('admin-users-list', 'Carregando usuários...');
    return fetchCollection('users')
        .then(users => {
            adminUsersCache = users.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'pt-BR'));
            filterAdminUsers(document.getElementById('admin-users-search')?.value || '');
        })
        .catch(error => {
            console.error('Erro ao carregar usuários:', error);
            setListEmpty('admin-users-list', 'Erro ao carregar usuários.');
        });
}

function filterAdminUsers(query) {
    const term = (query || '').trim().toLowerCase();
    const users = term
        ? adminUsersCache.filter(user => `${user.name || ''} ${user.email || ''} ${user.userType || ''}`.toLowerCase().includes(term))
        : adminUsersCache;
    renderUsers('admin-users-list', users);
}

function openUserModal(userId = null, options = {}) {
    if (!isAdminUser()) return alert('Apenas administradores podem gerenciar usuários.');
    editingUserId = userId;
    editingUserProfileMode = Boolean(options.profileMode);
    setText('user-modal-title', editingUserProfileMode ? 'Editar Perfil' : userId ? 'Editar Usuário' : 'Criar Usuário');
    ['user-name', 'user-email', 'user-password'].forEach(id => setValue(id, ''));
    setValue('user-type', 'aluno');
    setValue('user-status', 'active');

    if (!userId) {
        editingUserProfileMode = false;
        document.getElementById('user-modal').classList.remove('hidden');
        return Promise.resolve();
    }

    return db.collection('users').doc(userId).get().then(doc => {
        if (!doc.exists) throw new Error('Usuário não encontrado.');
        const user = doc.data();
        setValue('user-name', user.name || '');
        setValue('user-email', user.email || '');
        setValue('user-type', user.userType || 'aluno');
        setValue('user-status', user.status || 'active');
        document.getElementById('user-modal').classList.remove('hidden');
    }).catch(error => alert('Erro ao abrir usuário: ' + getAuthErrorMessage(error)));
}

function closeUserModal() {
    document.getElementById('user-modal').classList.add('hidden');
    editingUserId = null;
    editingUserProfileMode = false;
}

function saveUser() {
    if (!isAdminUser()) return alert('Apenas administradores podem gerenciar usuários.');
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
            if (editingUserId === currentUser.uid) {
                currentUser = { ...currentUser, name, email, userType, status };
                setText('admin-name', name || email);
            }
            alert(editingUserProfileMode ? 'Perfil atualizado com sucesso!' : 'Usuário atualizado com sucesso!');
            closeUserModal();
            loadAdminUsers();
        }).catch(error => alert('Erro ao atualizar usuário: ' + getAuthErrorMessage(error)));
        return;
    }

    createManagedUser({ name, email, password, userType, status })
        .then(() => {
            alert('Usuário criado com sucesso!');
            closeUserModal();
            loadAdminUsers();
        })
        .catch(error => alert('Erro ao criar usuário: ' + getAuthErrorMessage(error)));
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
    if (!isAdminUser()) return alert('Apenas administradores podem excluir usuários.');
    if (!confirm('Tem certeza que deseja excluir este usuário do Firestore?')) return;
    db.collection('users').doc(userId).delete()
        .then(() => {
            alert('Usuário excluído com sucesso!');
            isAdminUser() ? loadAdminUsers() : loadTeacherUsers();
        })
        .catch(error => alert('Erro ao excluir usuário: ' + getAuthErrorMessage(error)));
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
            if (!doc.exists) throw new Error('Quiz não encontrado.');
            const quiz = { id: doc.id, ...doc.data() };
            if (!canEditQuiz(quiz)) throw new Error('Você só pode editar quizzes criados por você.');
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
        return alert('Preencha título, categoria, número de questões e tempo.');
    }
    if (visibility === 'specific' && selectedIds.length === 0) {
        return alert('Selecione pelo menos um aluno.');
    }

    const request = editingQuizId
        ? db.collection('quizzes').doc(editingQuizId).get().then(doc => {
            if (!doc.exists) throw new Error('Quiz não encontrado.');
            const quiz = { id: doc.id, ...doc.data() };
            if (!canEditQuiz(quiz)) throw new Error('Você só pode editar quizzes criados por você.');
            return db.collection('quizzes').doc(editingQuizId).set(quizData, { merge: true });
        })
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
                <h3 class="card-title">${escapeHtml(quiz.title || 'Sem título')}</h3>
                <span class="card-badge ${quiz.status === 'active' ? '' : 'card-badge-secondary'}">${quiz.status === 'active' ? 'Ativo' : 'Inativo'}</span>
            </div>
            <div class="card-content">
                <p>${escapeHtml(quiz.description || 'Sem descrição')}</p>
                <p><strong>Categoria:</strong> ${escapeHtml(quiz.category || 'Geral')}</p>
                <p><strong>Questões:</strong> ${quiz.questionsCount || 0}</p>
                <p><strong>Tempo:</strong> ${quiz.time || 0} minutos</p>
                <p><strong>Visibilidade:</strong> ${escapeHtml(quiz.visibility || 'all')}</p>
            </div>
            <div class="card-actions">
                ${canEditQuiz(quiz) ? `<button class="btn btn-primary quiz-edit" data-id="${escapeHtml(quiz.id)}"><i class="fas fa-edit"></i><span class="btn-text">Editar</span></button>` : ''}
                <button class="btn btn-secondary admin-quiz-link" data-id="${escapeHtml(quiz.id)}"><i class="fas fa-link"></i><span class="btn-text">Link</span></button>
                ${canDeleteQuiz(quiz) ? `<button class="btn btn-danger quiz-delete" data-id="${escapeHtml(quiz.id)}"><i class="fas fa-trash"></i><span class="btn-text">Excluir</span></button>` : ''}
                ${!canEditQuiz(quiz) ? '<span class="card-badge card-badge-secondary">Somente visualização</span>' : ''}
            </div>
        </div>
    `).join('');

    addClickHandler('#admin-quizzes-list .quiz-edit', event => {
        const quiz = quizzes.find(item => item.id === event.currentTarget.dataset.id);
        if (quiz && quiz.roomId) openTeacherQuizModal(quiz.id);
        else openQuizModal(event.currentTarget.dataset.id);
    });
    addClickHandler('#admin-quizzes-list .quiz-delete', event => deleteQuiz(event.currentTarget.dataset.id, loadAdminQuizzes));
    addClickHandler('#admin-quizzes-list .admin-quiz-link', event => copyQuizLink(event.currentTarget.dataset.id));
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
    return db.collection('quizzes').doc(quizId).get()
        .then(doc => {
            if (!doc.exists) throw new Error('Quiz não encontrado.');
            const quiz = { id: doc.id, ...doc.data() };
            if (!canDeleteQuiz(quiz)) throw new Error('Você só pode excluir quizzes criados por você.');
            if (!confirm('Tem certeza que deseja excluir este quiz?')) return false;
            return db.collection('quizzes').doc(quizId).delete();
        })
        .then(deleted => {
            if (deleted === false) return;
            alert('Quiz excluído com sucesso!');
            onDone();
        })
        .catch(error => alert('Erro ao excluir quiz: ' + getAuthErrorMessage(error)));
}

function canManageQuestions() {
    return isAdminUser() || isTeacherUser();
}

function questionOwnedByCurrentUser(question) {
    return Boolean(currentUser && question && (
        question.ownerId === currentUser.uid ||
        question.teacherId === currentUser.uid
    ));
}

function canEditQuestion(question) {
    return isAdminUser() || (isTeacherUser() && questionOwnedByCurrentUser(question));
}

function canDeleteQuestion(question) {
    return isAdminUser() || (isTeacherUser() && questionOwnedByCurrentUser(question));
}

function refreshQuestionsLists() {
    if (isAdminUser()) return loadAdminQuestions();
    if (isTeacherUser()) return loadTeacherQuestions();
    return Promise.resolve();
}

function openQuestionModal(questionId = null) {
    if (!canManageQuestions()) return alert('Apenas administradores e professores podem gerenciar questões.');
    editingQuestionId = questionId;
    setText('question-modal-title', questionId ? 'Editar Questão' : 'Adicionar Nova Questão');
    ['question-text', 'question-category', 'option-a', 'option-b', 'option-c', 'option-d'].forEach(id => setValue(id, ''));
    setValue('correct-answer', 'a');

    if (!questionId) {
        document.getElementById('question-modal').classList.remove('hidden');
        return Promise.resolve();
    }

    return db.collection('questions').doc(questionId).get().then(doc => {
        if (!doc.exists) throw new Error('Questão não encontrada.');
        const question = { id: doc.id, ...doc.data() };
        if (!canEditQuestion(question)) {
            throw new Error('Você só pode editar questões criadas por você.');
        }
        setValue('question-text', question.text || '');
        setValue('question-category', question.category || '');
        setValue('option-a', question.options?.a || '');
        setValue('option-b', question.options?.b || '');
        setValue('option-c', question.options?.c || '');
        setValue('option-d', question.options?.d || '');
        setValue('correct-answer', question.correctAnswer || 'a');
        document.getElementById('question-modal').classList.remove('hidden');
    }).catch(error => alert('Erro ao abrir questão: ' + getAuthErrorMessage(error)));
}

function closeQuestionModal() {
    document.getElementById('question-modal').classList.add('hidden');
    editingQuestionId = null;
}

function saveQuestion() {
    if (!canManageQuestions()) return alert('Apenas administradores e professores podem gerenciar questões.');
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
        ? db.collection('questions').doc(editingQuestionId).get().then(doc => {
            if (!doc.exists) throw new Error('Questão não encontrada.');
            const question = { id: doc.id, ...doc.data() };
            if (!canEditQuestion(question)) {
                throw new Error('Você só pode editar questões criadas por você.');
            }
            return db.collection('questions').doc(editingQuestionId).set(data, { merge: true });
        })
        : db.collection('questions').add({
            ...data,
            ...getOwnerPayload(),
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });

    request.then(() => {
        alert('Questão salva com sucesso!');
        closeQuestionModal();
        refreshQuestionsLists();
    }).catch(error => alert('Erro ao salvar questão: ' + getAuthErrorMessage(error)));
}

function getQuestionOwnerLabel(question) {
    if (question.ownerName || question.teacherName) return question.ownerName || question.teacherName;
    if (question.ownerType === 'admin') return 'Administrador';
    if (question.ownerType === 'professor') return 'Professor';
    return 'Não informado';
}

function renderQuestions(listId, questions) {
    const list = document.getElementById(listId);
    if (!list) return;
    if (!questions.length) return setListEmpty(listId, 'Nenhuma questão cadastrada.');

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
                <p><strong>Criada por:</strong> ${escapeHtml(getQuestionOwnerLabel(question))}</p>
            </div>
            <div class="card-actions">
                ${canEditQuestion(question) ? `<button class="btn btn-primary question-edit" data-id="${escapeHtml(question.id)}"><i class="fas fa-edit"></i><span class="btn-text">Editar</span></button>` : ''}
                ${canDeleteQuestion(question) ? `<button class="btn btn-danger question-delete" data-id="${escapeHtml(question.id)}"><i class="fas fa-trash"></i><span class="btn-text">Excluir</span></button>` : ''}
            </div>
        </div>
    `).join('');

    addClickHandler(`#${listId} .question-edit`, event => openQuestionModal(event.currentTarget.dataset.id));
    addClickHandler(`#${listId} .question-delete`, event => deleteQuestion(event.currentTarget.dataset.id));
}

function loadAdminQuestions() {
    setListLoading('admin-questions-list', 'Carregando questões...');
    return fetchCollection('questions')
        .then(questions => renderQuestions('admin-questions-list', firebaseOrderByCreatedDesc(questions)))
        .catch(error => {
            console.error('Erro ao carregar questões:', error);
            setListEmpty('admin-questions-list', 'Erro ao carregar questões.');
        });
}

function loadTeacherQuestions() {
    setListLoading('teacher-questions-list', 'Carregando questões...');
    return fetchCollection('questions')
        .then(questions => renderQuestions('teacher-questions-list', firebaseOrderByCreatedDesc(questions)))
        .catch(error => {
            console.error('Erro ao carregar questões do professor:', error);
            setListEmpty('teacher-questions-list', 'Erro ao carregar questões.');
        });
}

function deleteQuestion(questionId) {
    return db.collection('questions').doc(questionId).get()
        .then(doc => {
            if (!doc.exists) throw new Error('Questão não encontrada.');
            const question = { id: doc.id, ...doc.data() };
            if (!canDeleteQuestion(question)) {
                throw new Error('Você só pode excluir questões criadas por você.');
            }
            if (!confirm('Tem certeza que deseja excluir esta questão?')) return false;
            return db.collection('questions').doc(questionId).delete();
        })
        .then(deleted => {
            if (deleted === false) return;
            alert('Questão excluída com sucesso!');
            refreshQuestionsLists();
        })
        .catch(error => alert('Erro ao excluir questão: ' + getAuthErrorMessage(error)));
}

function openImportModal() {
    document.getElementById('import-modal').classList.remove('hidden');
}

function closeImportModal() {
    document.getElementById('import-modal').classList.add('hidden');
}

function importQuestions() {
    if (!canManageQuestions()) return alert('Apenas administradores e professores podem importar questões em lote.');
    let questions;
    try {
        questions = JSON.parse(document.getElementById('json-data').value);
    } catch (error) {
        return alert('JSON inválido.');
    }
    if (!Array.isArray(questions) || questions.length === 0) return alert('Informe um array de questões.');

    const batch = db.batch();
    questions.forEach(question => {
        const ref = db.collection('questions').doc();
        batch.set(ref, {
            text: question.text || '',
            category: question.category || 'Geral',
            options: question.options || {},
            correctAnswer: question.correctAnswer || 'a',
            ...getOwnerPayload(),
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
    });

    batch.commit().then(() => {
        alert('Questões importadas com sucesso!');
        closeImportModal();
        refreshQuestionsLists();
    }).catch(error => alert('Erro ao importar questões: ' + getAuthErrorMessage(error)));
}

function loadQuizzes() {
    const list = setListLoading('quizzes-list', 'Carregando quizzes...');
    if (!list) return Promise.resolve();
    return Promise.all([fetchCollectionWhere('quizzes', 'status', '==', 'active'), fetchStudentRooms(), getStudentQuizAttempts()])
        .then(([quizzes, rooms, attempts]) => {
            const activeRooms = rooms.filter(room => (room.studentIds || []).includes(currentUser.uid));
            const roomIds = activeRooms.map(room => room.id);
            const attemptsByQuiz = mapAttemptsByQuiz(attempts);
            const visible = quizzes.filter(quiz => {
                if (quiz.status !== 'active') return false;
                if (quiz.visibility === 'specific') return (quiz.allowedStudents || []).includes(currentUser.uid);
                if (quiz.visibility === 'room') return quiz.roomId && roomIds.includes(quiz.roomId);
                return !quiz.visibility || quiz.visibility === 'all';
            });

            if (!visible.length) return setListEmpty('quizzes-list', 'Nenhum quiz disponível.');
            list.innerHTML = firebaseOrderByCreatedDesc(visible).map(quiz => `
                ${(() => {
                    const quizAttempts = attemptsByQuiz[quiz.id] || [];
                    const completedAttempt = getLatestAttempt(quizAttempts, 'completed');
                    const inProgressAttempt = getLatestAttempt(quizAttempts, 'in-progress');
                    const isCompleted = Boolean(completedAttempt);
                    const buttonText = isCompleted ? 'Concluído' : inProgressAttempt ? 'Continuar' : 'Iniciar';
                    const buttonClass = isCompleted ? 'btn-secondary' : 'btn-primary';
                    return `
                <div class="card">
                    <div class="card-header"><h3 class="card-title">${escapeHtml(quiz.title)}</h3><span class="card-badge ${isCompleted ? 'card-badge-secondary' : ''}">${isCompleted ? 'Concluído' : escapeHtml(quiz.category || 'Geral')}</span></div>
                    <div class="card-content">
                        <p>${escapeHtml(quiz.description || 'Sem descrição')}</p>
                        <p><strong>Questões:</strong> ${quiz.questionsCount || 0}</p>
                        <p><strong>Tempo:</strong> ${quiz.time || 0} minutos</p>
                        ${isCompleted ? `<p><strong>Nota:</strong> ${Number(completedAttempt.score || 0)}%</p>` : ''}
                        ${inProgressAttempt && !isCompleted ? `<p><strong>Saídas:</strong> ${Number(inProgressAttempt.exitCount || 0)}/3</p>` : ''}
                    </div>
                    <div class="card-actions">
                        <button class="btn ${buttonClass} quiz-start" data-id="${escapeHtml(quiz.id)}" ${isCompleted ? 'disabled' : ''}><i class="fas fa-play"></i><span class="btn-text">${buttonText}</span></button>
                    </div>
                </div>
                    `;
                })()}
            `).join('');
            addClickHandler('#quizzes-list .quiz-start', event => startQuiz(event.currentTarget.dataset.id));
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
    const usersRequest = isAdminUser() || isTeacherUser() ? fetchCollection('users') : Promise.resolve([]);
    return Promise.all([fetchCollectionWhere('userQuizzes', 'status', '==', 'completed'), usersRequest])
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
        if (!scores[userId]) {
            scores[userId] = {
                userId,
                userName: result.userName || usersMap[userId]?.name || 'Aluno',
                totalScore: 0,
                totalQuizzes: 0
            };
        }
        scores[userId].totalScore += Number(result.score || 0);
        scores[userId].totalQuizzes += 1;
    });
    const ranking = Object.values(scores)
        .map(item => ({ ...item, averageScore: item.totalQuizzes ? Math.round(item.totalScore / item.totalQuizzes) : 0 }))
        .sort((a, b) => b.averageScore - a.averageScore || b.totalScore - a.totalScore);
    if (!ranking.length) return setListEmpty(listId, 'Nenhum resultado encontrado.');
    list.innerHTML = ranking.map((item, index) => `
        <div class="ranking-item">
            <div class="ranking-position">${index + 1}</div>
            <div class="ranking-info">
                <div class="ranking-name">${escapeHtml(usersMap[item.userId]?.name || item.userName || 'Usuário')}</div>
                <div class="ranking-details">${item.totalQuizzes} quiz(es)</div>
            </div>
            <div class="ranking-score">${item.averageScore}%</div>
        </div>
    `).join('');
}

function populateQuizRankingSelect(selectId, quizzes) {
    const select = document.getElementById(selectId);
    if (!select) return;
    const currentValue = select.value;
    select.innerHTML = '<option value="">Selecione um quiz...</option>';
    firebaseOrderByCreatedDesc([...quizzes]).forEach(quiz => {
        const option = document.createElement('option');
        option.value = quiz.id;
        option.textContent = quiz.title || 'Quiz';
        select.appendChild(option);
    });
    if (currentValue && quizzes.some(quiz => quiz.id === currentValue)) select.value = currentValue;
}

function getQuizzesForRankingScope(scope) {
    if (scope === 'student') return getVisibleStudentQuizzes();
    if (scope === 'teacher') {
        return Promise.all([getManagedRooms(), fetchOwnedQuizzesForCurrentUser()]).then(([rooms, quizzes]) => {
            const roomIds = rooms.map(room => room.id);
            return quizzes.filter(quiz => quizVisibleForCurrentTeacher(quiz, roomIds));
        });
    }
    return fetchCollection('quizzes');
}

function loadSelectedQuizRanking(scope, selectId, listId) {
    const quizId = document.getElementById(selectId)?.value || '';
    if (!quizId) {
        setListEmpty(listId, 'Selecione um quiz para ver o ranking específico.');
        return Promise.resolve();
    }

    const usersRequest = isAdminUser() || isTeacherUser() ? fetchCollection('users') : Promise.resolve([]);
    return Promise.all([
        fetchQuery(db.collection('userQuizzes').where('quizId', '==', quizId).where('status', '==', 'completed')),
        usersRequest
    ])
        .then(([results, users]) => renderRankingList(listId, results, users))
        .catch(error => {
            console.error('Erro ao carregar ranking por quiz:', error);
            setListEmpty(listId, 'Erro ao carregar ranking por quiz.');
        });
}

function loadQuizRankingSection(scope, selectId, listId) {
    setListEmpty(listId, 'Selecione um quiz para ver o ranking específico.');
    return getQuizzesForRankingScope(scope)
        .then(quizzes => {
            populateQuizRankingSelect(selectId, quizzes);
            if (document.getElementById(selectId)?.value) {
                return loadSelectedQuizRanking(scope, selectId, listId);
            }
            return null;
        })
        .catch(error => {
            console.error('Erro ao carregar quizzes do ranking:', error);
            setListEmpty(listId, 'Erro ao carregar quizzes do ranking.');
        });
}

function loadQuizRankings() {
    return loadQuizRankingSection('student', 'quiz-master-select', 'quiz-master-list');
}

function loadAdminQuizRankings() {
    return loadQuizRankingSection('admin', 'admin-quiz-master-select', 'admin-quiz-master-list');
}

function loadTeacherQuizRankings() {
    return Promise.all([getQuizzesForRankingScope('teacher'), fetchCollectionWhere('userQuizzes', 'status', '==', 'completed'), fetchUsersByType('aluno')])
        .then(([quizzes, results, users]) => {
            const quizIds = new Set(quizzes.map(quiz => quiz.id));
            renderRankingList('teacher-quiz-master-list', results.filter(result => quizIds.has(result.quizId)), users);
        })
        .catch(error => {
            console.error('Erro ao carregar ranking por quiz do professor:', error);
            setListEmpty('teacher-quiz-master-list', 'Erro ao carregar ranking por quiz.');
        });
}

function loadUserHistory() {
    const list = setListLoading('history-list', 'Carregando histórico...');
    if (!list) return Promise.resolve();
    return Promise.all([getStudentQuizAttempts(), fetchCollectionWhere('quizzes', 'status', '==', 'active')])
        .then(([attempts, quizzes]) => {
            const quizzesMap = Object.fromEntries(quizzes.map(quiz => [quiz.id, quiz]));
            const ordered = attempts.sort((a, b) => getAttemptTimestamp(b) - getAttemptTimestamp(a));
            if (!ordered.length) return setListEmpty('history-list', 'Nenhuma tentativa encontrada.');

            list.innerHTML = ordered.map(attempt => {
                const quiz = quizzesMap[attempt.quizId] || {};
                const completed = attempt.status === 'completed';
                return `
                    <div class="card">
                        <div class="card-header">
                            <h3 class="card-title">${escapeHtml(attempt.quizTitle || quiz.title || 'Quiz')}</h3>
                            <span class="card-badge ${completed ? '' : 'card-badge-secondary'}">${completed ? 'Concluído' : 'Em andamento'}</span>
                        </div>
                        <div class="card-content">
                            <p><strong>Nota:</strong> ${completed ? `${Number(attempt.score || 0)}%` : 'Em andamento'}</p>
                            <p><strong>Acertos:</strong> ${Number(attempt.correctAnswers || 0)} de ${Number(attempt.totalQuestions || quiz.questionsCount || 0)}</p>
                            <p><strong>Tempo:</strong> ${formatSeconds(Number(attempt.timeTaken || 0))}</p>
                            <p><strong>Saídas:</strong> ${Number(attempt.exitCount || 0)}/3</p>
                        </div>
                        <div class="card-actions">
                            ${!completed ? `<button class="btn btn-primary history-continue" data-id="${escapeHtml(attempt.quizId)}"><i class="fas fa-play"></i><span class="btn-text">Continuar</span></button>` : ''}
                        </div>
                    </div>
                `;
            }).join('');
            addClickHandler('#history-list .history-continue', event => startQuiz(event.currentTarget.dataset.id));
        })
        .catch(error => {
            console.error('Erro ao carregar histórico:', error);
            setListEmpty('history-list', 'Erro ao carregar histórico.');
        });
}

function loadAdminReports() {
    return loadReports('admin-reports-content');
}

function loadTeacherReports() {
    const containerId = 'teacher-reports-content';
    const container = setListLoading(containerId, 'Carregando relatórios...');
    if (!container) return Promise.resolve();

    return Promise.all([getManagedRooms(), fetchUsersByType('aluno'), fetchOwnedQuizzesForCurrentUser(), fetchCollection('questions')])
        .then(([rooms, students, quizzes, questions]) => {
            const roomIds = rooms.map(room => room.id);
            const visibleStudents = students.filter(student => (student.roomIds || []).some(roomId => roomIds.includes(roomId)));
            const visibleQuizzes = quizzes.filter(quiz => quizVisibleForCurrentTeacher(quiz, roomIds));
            container.innerHTML = `
                <div class="card"><div class="card-content"><h3>${visibleStudents.length}</h3><p>Alunos</p></div></div>
                <div class="card"><div class="card-content"><h3>${rooms.length}</h3><p>Salas</p></div></div>
                <div class="card"><div class="card-content"><h3>${visibleQuizzes.length}</h3><p>Quizzes</p></div></div>
                <div class="card"><div class="card-content"><h3>${questions.length}</h3><p>Questões</p></div></div>
            `;
        })
        .catch(error => {
            console.error('Erro ao carregar relatórios do professor:', error);
            setListEmpty(containerId, 'Erro ao carregar relatórios.');
        });
}

function loadReports(containerId) {
    const container = setListLoading(containerId, 'Carregando relatórios...');
    if (!container) return Promise.resolve();
    return Promise.all([fetchCollection('users'), getVisibleRoomsForDashboard(), fetchCollection('quizzes'), fetchCollection('questions')])
        .then(([users, rooms, quizzes, questions]) => {
            container.innerHTML = `
                <div class="card"><div class="card-content"><h3>${users.length}</h3><p>Usuários</p></div></div>
                <div class="card"><div class="card-content"><h3>${rooms.length}</h3><p>Salas</p></div></div>
                <div class="card"><div class="card-content"><h3>${quizzes.length}</h3><p>Quizzes</p></div></div>
                <div class="card"><div class="card-content"><h3>${questions.length}</h3><p>Questões</p></div></div>
            `;
        })
        .catch(error => {
            console.error('Erro ao carregar relatórios:', error);
            setListEmpty(containerId, 'Erro ao carregar relatórios.');
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
window.loadTeacherQuestions = loadTeacherQuestions;
window.openQuestionModal = openQuestionModal;
window.closeQuestionModal = closeQuestionModal;
window.saveQuestion = saveQuestion;
window.openImportModal = openImportModal;
window.closeImportModal = closeImportModal;
window.importQuestions = importQuestions;
window.loadQuizzes = loadQuizzes;
window.startQuiz = startQuiz;
window.loadQuizQuestions = loadQuizQuestions;
window.displayQuestion = displayQuestion;
window.selectAnswer = selectAnswer;
window.finishQuiz = finishQuiz;
window.handleReviewClick = handleReviewClick;
window.closeReviewModal = closeReviewModal;
window.loadRanking = loadRanking;
window.loadAdminRanking = loadAdminRanking;
window.loadTeacherRanking = loadTeacherRanking;
window.loadQuizRankings = loadQuizRankings;
window.loadAdminQuizRankings = loadAdminQuizRankings;
window.loadTeacherQuizRankings = loadTeacherQuizRankings;
window.loadUserHistory = loadUserHistory;
window.loadAdminReports = loadAdminReports;
window.loadTeacherReports = loadTeacherReports;
