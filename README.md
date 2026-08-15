# QuizMaster - Sistema de Quiz Educacional

O **QuizMaster** é uma aplicação web educacional para organizar salas, alunos, quizzes, questões, rankings e relatórios em um ambiente simples para estudantes, professores e administradores.

O projeto usa Firebase Authentication, Cloud Firestore, Firebase Security Rules e Firebase Hosting. A interface é feita com HTML, CSS e JavaScript puro, sem etapa de build.

## Funcionalidades Atuais

### Autenticação e Acesso

- Login com e-mail e senha.
- Login com Google.
- Cadastro público de alunos e professores.
- Criação do primeiro administrador pelo cadastro público somente quando ainda não existe administrador.
- Bloqueio do cadastro público de novos administradores depois que o primeiro administrador existe.
- Criação de novos administradores somente por um administrador autenticado.
- Persistência de sessão no navegador.
- Redirecionamento automático por link de quiz após login do aluno.
- Mensagens de erro tratadas para os principais problemas de autenticação.

### Perfis de Usuário

- **Aluno:** acessa quizzes disponíveis, realiza tentativas, revisa respostas quando permitido, consulta ranking, ranking por quiz, histórico e informações da aplicação.
- **Professor:** gerencia suas próprias salas, quizzes por sala, questões criadas por ele, alunos, ranking, relatórios e o próprio perfil.
- **Administrador:** possui recursos administrativos e também recursos de professor, com gerenciamento de usuários, quizzes globais, questões e relatórios.

### Alunos

- Visualização de quizzes disponíveis conforme visibilidade configurada.
- Acesso a quizzes globais, quizzes específicos e quizzes vinculados às salas em que o aluno foi incluído.
- Execução de quiz com temporizador, progresso salvo e proteção visual contra cópia/captura.
- Registro de tentativa em `userQuizzes`, com pontuação, acertos, erros e tempo utilizado.
- Revisão de respostas quando o quiz permite.
- Acesso por link direto de quiz: se o aluno já estiver autenticado, entra no quiz; se não estiver, faz login e é redirecionado ao quiz.

### Professores

- Criação, edição, listagem e exclusão apenas das próprias salas.
- Vinculação de alunos às salas criadas pelo professor.
- Criação e edição de quizzes vinculados às próprias salas.
- Geração de link/código de acesso para quizzes por sala.
- Aba **Questões** para cadastrar, visualizar, editar e excluir questões criadas pelo próprio professor.
- Visualização de todas as questões disponíveis no banco para uso em quizzes.
- Listagem de usuários do tipo Aluno.
- Cadastro e edição de alunos, incluindo status e salas vinculadas.
- Sem permissão para excluir usuários do sistema.
- Menu de perfil no cabeçalho para editar o próprio cadastro.
- Acesso a rankings e relatórios relacionados aos alunos, salas e quizzes sob sua responsabilidade.

### Administradores

- Gerenciamento de usuários: alunos, professores e administradores.
- Cadastro de usuários sem derrubar a sessão atual do administrador.
- Edição de status e dados cadastrais de usuários.
- Exclusão de usuários permitida somente ao administrador.
- Gerenciamento de quizzes globais.
- Gerenciamento de quizzes por sala criados pelo próprio administrador.
- Gerenciamento das próprias salas.
- Visualização, edição e exclusão de qualquer questão.
- Importação de questões por JSON.
- Relatórios gerais de usuários, quizzes, questões e salas próprias.
- Menu de perfil no cabeçalho para editar o próprio cadastro.

### Quizzes e Questões

- Quizzes globais com controle de visibilidade para todos os alunos ou alunos específicos.
- Quizzes específicos por sala, liberados somente para alunos vinculados à sala.
- Controle de título, descrição, categoria, quantidade de questões, tempo, status e revisão.
- Banco de questões categorizado.
- Questões visíveis para professores e administradores.
- Professores podem criar, editar e excluir apenas as questões que criaram.
- Administradores podem editar e excluir qualquer questão.
- Importação de questões por JSON restrita ao administrador.

### Salas

- Criação de turmas/salas.
- Associação de alunos às salas.
- Status ativo/inativo.
- Responsável pela sala identificado por professor ou administrador.
- Salas criadas por um professor ficam visíveis somente para o próprio professor e para os alunos vinculados.
- Salas criadas por um administrador ficam visíveis somente para o próprio administrador e para os alunos vinculados.
- Outros professores e administradores não visualizam nem gerenciam salas criadas por terceiros.

### Segurança

- Regras do Cloud Firestore versionadas em `firestore.rules`.
- Regras separadas por perfil de usuário.
- Professores podem ver alunos e o próprio cadastro, mas não podem ver dados de outros professores ou administradores.
- Professores não podem excluir usuários.
- Salas são isoladas por criador/responsável.
- Questões têm permissão de escrita por proprietário ou administrador.
- A API key do Firebase Web é pública por natureza; a proteção real depende das regras do Firestore, restrições da chave no Google Cloud e Firebase App Check.

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

## Configuração Local

1. Clone o repositório:

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

## Observações Importantes

- O arquivo `public/config.js` é público no navegador por natureza. Isso é esperado em apps Firebase Web.
- Restrinja a API key no Google Cloud por domínio e por APIs usadas.
- Ative o Firebase App Check para reduzir abuso da aplicação.
- Depois de alterar `firestore.rules`, publique as regras com `firebase deploy --only firestore:rules`.

## Autor

Desenvolvido por Luiz Sérgio Garcia Carvalho.

## Legal e Termos de Uso

### Direitos Autorais
Todo o conteúdo, código, imagens e recursos deste projeto são protegidos por leis de direitos autorais. O uso, cópia ou distribuição não autorizada pode resultar em sanções legais.

### Regras de Segurança
O projeto utiliza Firebase Authentication e Cloud Firestore com regras de segurança configuradas em `firestore.rules`. É responsabilidade dos administradores manter as regras atualizadas e garantir que apenas usuários autorizados tenham acesso a dados sensíveis.

### Termos de Uso
Ao utilizar o QuizMaster, você concorda com os seguintes termos:

1. **Uso Responsável** – O aplicativo é destinado a fins educacionais. O uso indevido pode resultar em bloqueio de conta.
2. **Privacidade** – Os dados pessoais são armazenados no Firebase e são usados apenas para fins de autenticação e para melhorar a experiência do usuário.
3. **Colaboração** – Cada questão inserida fica armazenada no banco de questões e pode ser acessada por outros usuários, contribuindo para a comunidade.
4. **Responsabilidade** – O desenvolvedor não se responsabiliza por perdas de dados ou interrupções de serviço.

### Política de Dados
Os dados de usuários são coletados apenas para fins de autenticação e para armazenar progresso em quizzes. Nenhum dado sensível é compartilhado com terceiros sem consentimento explícito.
