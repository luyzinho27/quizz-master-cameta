// Tab Listeners para o Professor

// Aguardar um pouco para garantir que os elementos estão prontos
function initProfessorTabListener() {
    setTimeout(function() {
        const professorRoomsTab = document.getElementById('professor-rooms-tab');
        if (professorRoomsTab) {
            professorRoomsTab.addEventListener('click', () => {
                switchProfessorTab('professor-rooms-tab', 'professor-rooms-section');
                loadProfessorRooms();
            });
        }
        
        const professorStudentsTab = document.getElementById('professor-students-tab');
        if (professorStudentsTab) {
            professorStudentsTab.addEventListener('click', () => {
                switchProfessorTab('professor-students-tab', 'professor-students-section');
                loadProfessorStudents();
            });
        }
        
        const professorQuizzesTab = document.getElementById('professor-quizzes-tab');
        if (professorQuizzesTab) {
            professorQuizzesTab.addEventListener('click', () => {
                switchProfessorTab('professor-quizzes-tab', 'professor-quizzes-section');
                loadProfessorQuizzes();
            });
        }
        
        const professorReportsTab = document.getElementById('professor-reports-tab');
        if (professorReportsTab) {
            professorReportsTab.addEventListener('click', () => {
                switchProfessorTab('professor-reports-tab', 'professor-reports-section');
                loadProfessorReports();
            });
        }
        
        const professorAboutTab = document.getElementById('professor-about-tab');
        if (professorAboutTab) {
            professorAboutTab.addEventListener('click', () => {
                switchProfessorTab('professor-about-tab', 'professor-about-section');
            });
        }
    }, 500);
}

// Inicializar listeners quando página é carregada
document.addEventListener('DOMContentLoaded', function() {
    initProfessorTabListener();
});
