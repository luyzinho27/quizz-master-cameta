// Model de usuário
class User {
	constructor(id, name, role, active = true) {
		this.id = id;
		this.name = name;
		this.role = role; // 'admin', 'professor', 'aluno'
		this.active = active;
	}

	// Métodos de validação
	isAdmin() { return this.role === 'admin'; }
	isProfessor() { return this.role === 'professor'; }
	isAluno() { return this.role === 'aluno'; }

	// Permissões por papel
	canCreateUsers() { return this.role === 'admin'; }
	canDeleteUsers() { return this.role === 'admin'; }
	canEditUsers() { return this.role === 'admin' || this.role === 'professor'; }
	canCreateSala() { return this.role === 'admin' || this.role === 'professor'; }
	canAddAlunoToSala() { return this.role === 'admin' || this.role === 'professor'; }
	canViewRankings() { return this.role === 'admin' || this.role === 'professor'; }
}