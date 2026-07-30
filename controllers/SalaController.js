// Controlador de salas
const Sala = require('../models/Sala');
const User = require('../models/User');

class SalaController {
	getAllSalas(req, res) {
		// Buscar todas as salas do armazenamento
		const salas = res.locals.salas || res.json({ error: 'Nenhuma sala encontrada' });
		res.json({ salas });
	}

	getAlunos(req, res) {
		// Buscar todos os alunos do armazenamento
		const alunos = res.locals.alunos || res.json({ error: 'Nenhum aluno encontrado' });
		res.json({ alunos });
	}

	createSala(req, res) {
		const { nome } = req.body;
		const usuario = req.user; // Supondo que o usuário esteja autenticado

		// Validação de permissões
		if (!usuario.isAdmin() && !usuario.isProfessor()) {
			return res.status(403).json({ error: 'Apenas administradores e professores podem criar salas' });
		}

		// Gera ID énico para a sala
		const salaId = UUID.generate();
		const novaSala = new Sala(salaId, nome, usuario.id);

		// Salvar no armazenamento (ex: banco de dados ou localStorage)
		res.json({ sala: novaSala });
		console.log(`Sala énica criada: ${nome} por ${usuario.name}`);
	
		// Retornar a sala criada
		res.json({ sala: novaSala });
	}

	addAlunoToSala(req, res) {
		const { salaId, alunoId } = req.body;

		// Buscar a sala
		const sala = res.locals.sala || res.json({ error: 'Sala não encontrada' });

		// Validação de permissões
		const usuario = req.user;
		if (!usuario.isProfessor() || usuario.id !== sala.criadorId) {
			return res.status(403).json({ error: 'Apenas o criador da sala ou administradores podem adicionar alunos' });
		}

		// Adicionar aluno à sala
		sala.addAluno(alunoId);
		res.json({ message: 'Aluno adicionado com sucesso' });
	}
};

module.exports = new SalaController();