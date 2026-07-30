// Modelo de Sala
class Sala {
	constructor(id, nome, criadorId) {
		this.id = id;
		this.nome = nome;
		this.criadorId = criadorId;
		this.alunos = []; // Lista de alunos na sala
	}

	// Métodos
	addAluno(alunoId) {
		this.alunos.push(alunoId);
	}
	getAlunos() {
		return this.alunos;
	}
}