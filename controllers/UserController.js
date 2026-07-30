// Controlador de usuários
const User = require('../models/User');

class UserController {
	registerUser(req, res) {
		const { name, email, role } = req.body;

		// Validação básica
		if (!name || !email || !role) {
			return res.status(400).json({ error: 'Campos obrigatórios faltando' });
		}

		// Criação do usuário
		const newUser = new User(
			UUID.generate(), // ID único
			name,
			email,
			role
		);

		// Validação de permissóes
		if (role === 'admin' && !req.body.canCreateAdmins) {
			return res.status(400).json({ error: 'Administradores não podem ser criados por outros usuários' });
		}

		// Salvar no armazenamento (ex: banco de dados ou localStorage)
		res.json({ user: newUser });
		console.log(`Usuário ${role} cadastrado: ${name}`);
	}

	// Métodos para login, atualização e exclusão seguiriam aqui
};

module.exports = new UserController();