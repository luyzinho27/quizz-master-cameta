# QuizMaster - Sistema de Quiz Educacional

O **QuizMaster** e uma aplicacao web educacional para organizar quizzes, turmas, alunos, rankings e relatorios em um ambiente simples para estudantes, professores e administradores.

O projeto usa Firebase Authentication, Cloud Firestore e Firebase Hosting. A interface e feita com HTML, CSS e JavaScript puro, sem etapa de build.

## Funcionalidades Atuais

### Autenticacao e Acesso

- Login com e-mail e senha.
- Login com Google.
- Cadastro publico de alunos e professores.
- Criacao do primeiro administrador pelo cadastro publico somente quando ainda nao existe admin.
- Bloqueio do cadastro publico de novos administradores depois que o primeiro admin existe.
- Criacao de novos administradores somente por um administrador autenticado.
- Persistencia de sessao no navegador.
- Mensagens de erro tratadas para os principais problemas de autenticacao.

### Perfis de Usuario

- **Aluno:** acessa quizzes disponiveis, ranking, ranking por quiz, historico e informacoes da aplicacao.
- **Professor:** gerencia salas, quizzes por sala, alunos, ranking, relatorios e o proprio perfil.
- **Administrador:** possui os recursos administrativos e tambem os recursos de professor, incluindo gerenciamento de salas e quizzes por sala.

### Alunos

- Visualizacao de quizzes disponiveis conforme visibilidade configurada.
- Acesso a ranking geral e area de ranking por quiz.
- Historico reservado para acompanhamento de tentativas.
- Protecoes visuais durante a realizacao de quiz, incluindo tela de protecao contra captura.

### Professores

- Criacao, edicao, listagem e exclusao de salas proprias.
- Vinculo de alunos a salas.
- Criacao e edicao de quizzes vinculados a salas.
- Listagem de usuarios do tipo Aluno.
- Cadastro e edicao de alunos, incluindo status e salas vinculadas.
- Sem permissao de excluir usuarios do sistema.
- Menu de perfil no cabecalho para editar o proprio cadastro.
- Acesso a rankings e relatorios relacionados aos alunos, salas e quizzes.

### Administradores

- Gerenciamento de usuarios: alunos, professores e administradores.
- Cadastro de usuarios sem derrubar a sessao atual do administrador.
- Edicao de status e dados cadastrais de usuarios.
- Exclusao de usuarios permitida somente ao administrador.
- Gerenciamento de quizzes globais.
- Gerenciamento de quizzes por sala.
- Gerenciamento de salas.
- Gerenciamento do banco de questoes.
- Importacao de questoes por JSON.
- Relatorios gerais de usuarios, salas, quizzes e questoes.
- Menu de perfil no cabecalho para editar o proprio cadastro.

### Quizzes e Questoes

- Quizzes globais com controle de visibilidade.
- Quizzes especificos por sala.
- Controle de titulo, descricao, categoria, quantidade de questoes, tempo, status e revisao.
- Banco de questoes categorizado.
- Cadastro, edicao, exclusao e importacao de questoes.

### Salas

- Criacao de turmas/salas.
- Associacao de alunos as salas.
- Status ativo/inativo.
- Responsavel pela sala identificado por professor ou administrador.
- Uso das salas para limitar quizzes e relatorios.

### Seguranca

- Regras do Cloud Firestore versionadas em `firestore.rules`.
- Regras separadas por perfil de usuario.
- Professores podem ver alunos e o proprio cadastro, mas nao podem ver dados de outros professores ou administradores.
- Professores nao podem excluir usuarios.
- Administradores concentram permissoes administrativas.
- `public/config.js` contem apenas configuracao publica do Firebase Web; a protecao real fica em regras do Firestore, restricoes da chave no Google Cloud e App Check.

## Estrutura do Projeto

```text
.
|-- firebase.json
|-- firestore.rules
|-- public/
|   |-- config.example.js
|   |-- config.js
|   |-- index.html
|   |-- script.js
|   |-- style.css
|   `-- images/
`-- README.md
```

## Tecnologias

- HTML5
- CSS3
- JavaScript Vanilla
- Firebase Authentication
- Cloud Firestore
- Firebase Hosting
- Firebase Security Rules
- Font Awesome

## Configuracao Local

1. Clone o repositorio:

```bash
git clone https://github.com/luyzinho27/quizz-master-cameta.git
cd quizz-master-cameta
```

2. Configure o Firebase Web em `public/config.js`.

Use `public/config.example.js` como base:

```js
window.QUIZZ_MASTER_CAMETA_FIREBASE_CONFIG = {
  apiKey: 'SUA_API_KEY',
  authDomain: 'quizz-master-cameta.firebaseapp.com',
  projectId: 'quizz-master-cameta',
  storageBucket: 'quizz-master-cameta.firebasestorage.app',
  messagingSenderId: 'SEU_MESSAGING_SENDER_ID',
  appId: 'SEU_APP_ID'
};
```

3. Execute localmente com Firebase Hosting:

```bash
firebase serve --only hosting
```

ou:

```bash
firebase emulators:start --only hosting,firestore
```

## Deploy

Para publicar o site:

```bash
firebase deploy --only hosting:app
```

Para publicar as regras do Firestore:

```bash
firebase deploy --only firestore:rules
```

Quando houver problema de certificado no Windows/Node, use:

```powershell
$env:NODE_OPTIONS='--use-system-ca'
```

## Observacoes Importantes

- O arquivo `public/config.js` e publico no navegador por natureza. Isso e esperado em apps Firebase Web.
- Restrinja a API key no Google Cloud por dominio e por APIs usadas.
- Ative Firebase App Check para reduzir abuso da aplicacao.
- Depois de alterar `firestore.rules`, publique as regras com `firebase deploy --only firestore:rules`.

## Autor

Desenvolvido por Luiz Sergio Garcia Carvalho.
