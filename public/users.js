// User model with roles

const Users = {
  // Tipos de papel
  ADMIN: 'Administrator',
  PROFESSOR: 'Professor',
  ALUNO: 'Aluno'
};

// Estrutura de usuário com papel
class User {
  constructor(uid, name, email, role) {
    this.uid = uid;
    this.name = name;
    this.email = email;
    this.role = role;
  }
}

// Usuário inicial (Administrador)
const initialAdmin = new User('initial-admin', 'Admin System', 'admin@example.com', Users.ADMIN);