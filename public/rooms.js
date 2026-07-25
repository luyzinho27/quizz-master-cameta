// Room management functions

// Classe Room para gerenciar salas
class Room {
  constructor(creator, participants, quizes) {
    this.creator = creator; // Professor ou Administrador
    this.participants = participants; // Array de Alunos
    this.quizes = quizes; // Array de quizes criados
  }
}

// Atualiza a função createRoom para usar a classe Room
const Rooms = {
  createRoom: async (professorId, name, description) => {
    const room = new Room(professorId, [], []); // Inicializa com participantes vazios
    const roomRef = firebase.firestore().collection('rooms').doc();
    await roomRef.set({
      ...room,
      createdAt: new Date()
    });
    return roomRef.id;
  },

  addStudentToRoom: async (roomId, studentId) => {
    const roomRef = firebase.firestore().collection('rooms').doc(roomId);
    await roomRef.update({
      participants: firebase.firestore.FieldValue.arrayUnion(studentId)
    });
  },

  createQuiz: async (roomId, title, questions) => {
    const quizRef = firebase.firestore().collection('quizzes').doc();
    await quizRef.set({
      roomId,
      title,
      questions,
      createdAt: new Date()
    });
    // Add quiz reference to room
    const roomRef = firebase.firestore().collection('rooms').doc(roomId);
    await roomRef.update({
      quizes: firebase.firestore.FieldValue.arrayUnion(quizRef.id)
    });
    return quizRef.id;
  }
};

// Nova funcionalidade: Carregar alunos disponíveis para professor
function loadAvailableStudents() {
  // Carregar alunos disponíveis para professor
  db.collection('users').where('type', '==', 'student').get()
    .then(querySnapshot => {
      const students = [];
      querySnapshot.forEach(doc => {
        students.push({ id: doc.id, name: doc.data().displayName });
      });
      updateAvailableStudentsDisplay(students);
    });
}

// Nova funcionalidade: Criar sala
function createRoom(professorId, roomName) {
  db.collection('rooms').add({
    professorId: professorId,
    name: roomName,
    students: []
  })
    .then(() => {
      // Atualizar lista de salas
      loadRooms(professorId);
    });
}

// Nova funcionalidade: Adicionar aluno a sala
function addStudentToRoom(roomId, studentId) {
  db.collection('rooms').doc(roomId).update({
    students: firebase.firestore.FieldValue.arrayUnion(studentId)
  })
    .then(() => {
      // Atualizar lista de salas
      loadRooms(currentProfessorId);
    });
}

// Nova funcionalidade: Criar quiz para sala
function createQuizForRoom(roomId, quizName) {
  db.collection('quizzes').add({
    roomId: roomId,
    name: quizName,
    questions: []
  })
    .then(() => {
      // Atualizar lista de quizzes na sala
      loadQuizzesForRoom(roomId);
    });
}