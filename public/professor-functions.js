// ===============================
// GERENCIAMENTO DO PROFESSOR
// ===============================

// Alternar entre abas do professor
function switchProfessorTab(tabId, sectionId) {
    const tabs = document.querySelectorAll('#professor-dashboard .dashboard-header .tab');
    const sections = document.querySelectorAll('#professor-dashboard .dashboard-content .section');
    
    tabs.forEach(tab => tab.classList.remove('active'));
    sections.forEach(section => section.classList.remove('active'));
    
    document.getElementById(tabId).classList.add('active');
    document.getElementById(sectionId).classList.add('active');
}

// Carregar salas do professor
function loadProfessorRooms() {
    const roomsList = document.getElementById('professor-rooms-list');
    roomsList.innerHTML = '<div class="card"><div class="card-content">Carregando salas...</div></div>';
    
    if (!currentUser) return;
    
    db.collection('rooms')
        .where('teacherId', '==', currentUser.uid)
        .orderBy('createdAt', 'desc')
        .get()
        .then(querySnapshot => {
            roomsList.innerHTML = '';
            
            if (querySnapshot.empty) {
                roomsList.innerHTML = '<div class="card"><div class="card-content">Você ainda não criou nenhuma sala. <br><br><button class="btn btn-primary" onclick="openRoomModal()"><i class="fas fa-plus"></i> Criar Sala</button></div></div>';
                return;
            }
            
            querySnapshot.forEach(doc => {
                const room = { id: doc.id, ...doc.data() };
                const roomCard = createProfessorRoomCard(room);
                roomsList.appendChild(roomCard);
            });
        })
        .catch(error => {
            roomsList.innerHTML = '<div class="card"><div class="card-content">Erro ao carregar salas.</div></div>';
            console.error('Erro ao carregar salas do professor:', error);
        });
}

// Criar card de sala para professor
function createProfessorRoomCard(room) {
    const card = document.createElement('div');
    card.className = 'card';
    
    const studentCount = (room.studentIds && Array.isArray(room.studentIds)) ? room.studentIds.length : 0;
    const quizCount = (room.quizIds && Array.isArray(room.quizIds)) ? room.quizIds.length : 0;
    
    const statusBadge = room.status === 'active' ? 
        '<span class="card-badge success">Ativa</span>' : 
        '<span class="card-badge danger">Inativa</span>';
    
    card.innerHTML = `
        <div class="card-header">
            <h3 class="card-title"><i class="fas fa-door-open"></i> ${room.name}</h3>
            <div>
                ${statusBadge}
            </div>
        </div>
        <div class="card-content">
            <p><strong>Alunos:</strong> ${studentCount}</p>
            <p><strong>Quizzes:</strong> ${quizCount}</p>
            <p><strong>Criada em:</strong> ${room.createdAt ? room.createdAt.toDate().toLocaleDateString('pt-BR') : 'N/A'}</p>
        </div>
        <div class="card-actions">
            <button class="btn btn-primary edit-room" data-room-id="${room.id}">
                <i class="fas fa-edit"></i>
                <span class="btn-text">Editar</span>
            </button>
            <button class="btn btn-danger delete-room" data-room-id="${room.id}">
                <i class="fas fa-trash"></i>
                <span class="btn-text">Excluir</span>
            </button>
        </div>
    `;
    
    card.querySelector('.edit-room').addEventListener('click', () => {
        openRoomModal(room.id);
    });
    
    card.querySelector('.delete-room').addEventListener('click', () => {
        deleteRoom(room.id);
    });
    
    return card;
}

// Carregar alunos do professor
function loadProfessorStudents() {
    const studentsList = document.getElementById('professor-students-list');
    studentsList.innerHTML = '<div class="card"><div class="card-content">Carregando alunos...</div></div>';
    
    if (!currentUser) return;
    
    // Buscar todas as salas do professor
    db.collection('rooms')
        .where('teacherId', '==', currentUser.uid)
        .get()
        .then(roomsSnapshot => {
            const allStudentIds = new Set();
            
            roomsSnapshot.forEach(roomDoc => {
                const room = roomDoc.data();
                if (room.studentIds && Array.isArray(room.studentIds)) {
                    room.studentIds.forEach(studentId => allStudentIds.add(studentId));
                }
            });
            
            if (allStudentIds.size === 0) {
                studentsList.innerHTML = '<div class="card"><div class="card-content">Nenhum aluno adicionado às suas salas.</div></div>';
                return;
            }
            
            // Buscar dados dos alunos
            const batchSize = 10;
            const studentIdArray = Array.from(allStudentIds);
            const promises = [];
            
            for (let i = 0; i < studentIdArray.length; i += batchSize) {
                const batch = studentIdArray.slice(i, i + batchSize);
                promises.push(
                    db.collection('users')
                        .where(firebase.firestore.FieldPath.documentId(), 'in', batch)
                        .get()
                );
            }
            
            return Promise.all(promises);
        })
        .then(snapshots => {
            studentsList.innerHTML = '';
            const students = [];
            
            snapshots.forEach(snapshot => {
                snapshot.forEach(doc => {
                    students.push({ id: doc.id, ...doc.data() });
                });
            });
            
            students.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
            
            students.forEach(student => {
                const studentCard = createProfessorStudentCard(student);
                studentsList.appendChild(studentCard);
            });
        })
        .catch(error => {
            studentsList.innerHTML = '<div class="card"><div class="card-content">Erro ao carregar alunos.</div></div>';
            console.error('Erro ao carregar alunos do professor:', error);
        });
}

// Criar card de aluno para professor
function createProfessorStudentCard(student) {
    const card = document.createElement('div');
    card.className = 'card';
    
    const statusBadge = student.status === 'active' ? 
        '<span class="card-badge success">Ativo</span>' : 
        '<span class="card-badge danger">Inativo</span>';
    
    card.innerHTML = `
        <div class="card-header">
            <h3 class="card-title"><i class="fas fa-user-graduate"></i> ${student.name}</h3>
            <div>
                ${statusBadge}
            </div>
        </div>
        <div class="card-content">
            <p><strong>E-mail:</strong> ${student.email}</p>
            <p><strong>Status:</strong> ${student.status === 'active' ? 'Ativo' : 'Inativo'}</p>
            <p><strong>Cadastrado em:</strong> ${student.createdAt ? student.createdAt.toDate().toLocaleDateString('pt-BR') : 'N/A'}</p>
        </div>
        <div class="card-actions">
            <button class="btn btn-primary" onclick="editProfessorStudent('${student.id}')">
                <i class="fas fa-edit"></i>
                <span class="btn-text">Editar</span>
            </button>
            <button class="btn btn-secondary" onclick="toggleProfessorStudentStatus('${student.id}', '${student.status}')">
                <i class="fas fa-power-off"></i>
                <span class="btn-text">${student.status === 'active' ? 'Desativar' : 'Ativar'}</span>
            </button>
        </div>
    `;
    
    return card;
}

// Carregar quizzes do professor
function loadProfessorQuizzes() {
    const quizzesList = document.getElementById('professor-quizzes-list');
    quizzesList.innerHTML = '<div class="card"><div class="card-content">Carregando quizzes...</div></div>';
    
    if (!currentUser) return;
    
    // Buscar quizzes criados por este professor
    db.collection('quizzes')
        .where('createdBy', '==', currentUser.uid)
        .orderBy('createdAt', 'desc')
        .get()
        .then(querySnapshot => {
            quizzesList.innerHTML = '';
            
            if (querySnapshot.empty) {
                quizzesList.innerHTML = '<div class="card"><div class="card-content">Você ainda não criou nenhum quiz.</div></div>';
                return;
            }
            
            querySnapshot.forEach(doc => {
                const quiz = { id: doc.id, ...doc.data() };
                const quizCard = createProfessorQuizCard(quiz);
                quizzesList.appendChild(quizCard);
            });
        })
        .catch(error => {
            quizzesList.innerHTML = '<div class="card"><div class="card-content">Erro ao carregar quizzes.</div></div>';
            console.error('Erro ao carregar quizzes do professor:', error);
        });
}

// Criar card de quiz para professor
function createProfessorQuizCard(quiz) {
    const card = document.createElement('div');
    card.className = 'card';
    
    const statusBadge = quiz.status === 'active' ? 
        '<span class="card-badge success">Ativo</span>' : 
        '<span class="card-badge danger">Inativo</span>';
    
    card.innerHTML = `
        <div class="card-header">
            <h3 class="card-title">${quiz.title}</h3>
            <div>
                ${statusBadge}
            </div>
        </div>
        <div class="card-content">
            <p><strong>Descrição:</strong> ${quiz.description || 'Sem descrição'}</p>
            <p><strong>Questões:</strong> ${quiz.questionsCount || 0}</p>
            <p><strong>Tempo:</strong> ${quiz.time || 0} minutos</p>
            <p><strong>Criado em:</strong> ${quiz.createdAt ? quiz.createdAt.toDate().toLocaleDateString('pt-BR') : 'N/A'}</p>
        </div>
        <div class="card-actions">
            <button class="btn btn-primary" onclick="editProfessorQuiz('${quiz.id}')">
                <i class="fas fa-edit"></i>
                <span class="btn-text">Editar</span>
            </button>
            <button class="btn btn-danger" onclick="deleteProfessorQuiz('${quiz.id}')">
                <i class="fas fa-trash"></i>
                <span class="btn-text">Excluir</span>
            </button>
        </div>
    `;
    
    return card;
}

// Carregar relatórios do professor
function loadProfessorReports() {
    const reportsContent = document.getElementById('professor-reports-content');
    reportsContent.innerHTML = '<div class="card"><div class="card-content">Carregando relatórios...</div></div>';
    
    if (!currentUser) return;
    
    // Buscar salas, alunos e quizzes
    Promise.all([
        db.collection('rooms').where('teacherId', '==', currentUser.uid).get(),
        db.collection('userQuizzes').where('status', '==', 'completed').get()
    ])
    .then(([roomsSnapshot, userQuizzesSnapshot]) => {
        const totalRooms = roomsSnapshot.size;
        let totalStudents = 0;
        let totalAttempts = userQuizzesSnapshot.size;
        let totalScore = 0;
        let averageScore = 0;
        
        roomsSnapshot.forEach(roomDoc => {
            const room = roomDoc.data();
            if (room.studentIds && Array.isArray(room.studentIds)) {
                totalStudents += room.studentIds.length;
            }
        });
        
        userQuizzesSnapshot.forEach(doc => {
            const userQuiz = doc.data();
            totalScore += userQuiz.score || 0;
        });
        
        if (totalAttempts > 0) {
            averageScore = (totalScore / totalAttempts).toFixed(2);
        }
        
        reportsContent.innerHTML = `
            <div class="stats-grid">
                <div class="stat-card">
                    <div class="stat-icon"><i class="fas fa-door-open"></i></div>
                    <div class="stat-content">
                        <h3>Total de Salas</h3>
                        <p class="stat-value">${totalRooms}</p>
                    </div>
                </div>
                <div class="stat-card">
                    <div class="stat-icon"><i class="fas fa-user-graduate"></i></div>
                    <div class="stat-content">
                        <h3>Total de Alunos</h3>
                        <p class="stat-value">${totalStudents}</p>
                    </div>
                </div>
                <div class="stat-card">
                    <div class="stat-icon"><i class="fas fa-tasks"></i></div>
                    <div class="stat-content">
                        <h3>Total de Tentativas</h3>
                        <p class="stat-value">${totalAttempts}</p>
                    </div>
                </div>
                <div class="stat-card">
                    <div class="stat-icon"><i class="fas fa-chart-line"></i></div>
                    <div class="stat-content">
                        <h3>Média de Acertos</h3>
                        <p class="stat-value">${averageScore}</p>
                    </div>
                </div>
            </div>
        `;
    })
    .catch(error => {
        reportsContent.innerHTML = '<div class="card"><div class="card-content">Erro ao carregar relatórios.</div></div>';
        console.error('Erro ao carregar relatórios do professor:', error);
    });
}

// Abrir modal de sala
function openRoomModal(roomId = null) {
    editingRoomId = roomId;
    const modal = document.getElementById('room-modal');
    const title = document.getElementById('room-modal-title');
    
    // Limpar campos
    document.getElementById('room-name').value = '';
    document.getElementById('room-status').value = 'active';
    selectedRoomStudents = [];
    
    if (roomId) {
        title.textContent = 'Editar Sala';
        
        // Carregar dados da sala
        db.collection('rooms').doc(roomId).get()
            .then(doc => {
                if (doc.exists) {
                    const room = doc.data();
                    document.getElementById('room-name').value = room.name;
                    document.getElementById('room-status').value = room.status || 'active';
                    selectedRoomStudents = room.studentIds || [];
                    loadRoomAvailableStudents();
                }
            });
    } else {
        title.textContent = 'Criar Sala';
        loadRoomAvailableStudents();
    }
    
    modal.classList.remove('hidden');
}

// Carregar alunos disponíveis para a sala
function loadRoomAvailableStudents() {
    const studentsList = document.getElementById('room-students-list');
    studentsList.innerHTML = '<p>Carregando alunos...</p>';
    
    // Buscar todos os alunos do sistema
    db.collection('users')
        .where('userType', '==', 'aluno')
        .get()
        .then(querySnapshot => {
            const students = [];
            querySnapshot.forEach(doc => {
                students.push({ id: doc.id, ...doc.data() });
            });
            
            // Ordenar localmente por nome
            students.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
            
            studentsList.innerHTML = '';
            
            if (students.length === 0) {
                studentsList.innerHTML = '<p>Nenhum aluno cadastrado no sistema.</p>';
                return;
            }
            
            students.forEach(student => {
                const isSelected = selectedRoomStudents.includes(student.id);
                
                const studentCheckbox = document.createElement('div');
                studentCheckbox.className = 'student-checkbox';
                studentCheckbox.innerHTML = `
                    <label>
                        <input type="checkbox" value="${student.id}" ${isSelected ? 'checked' : ''}>
                        <span>${student.name}</span>
                    </label>
                `;
                
                studentCheckbox.querySelector('input').addEventListener('change', (e) => {
                    if (e.target.checked) {
                        if (!selectedRoomStudents.includes(student.id)) {
                            selectedRoomStudents.push(student.id);
                        }
                    } else {
                        selectedRoomStudents = selectedRoomStudents.filter(id => id !== student.id);
                    }
                });
                
                studentsList.appendChild(studentCheckbox);
            });
        })
        .catch(error => {
            studentsList.innerHTML = '<p>Erro ao carregar alunos.</p>';
            console.error('Erro ao carregar alunos disponíveis:', error);
        });
}

// Fechar modal de sala
function closeRoomModal() {
    document.getElementById('room-modal').classList.add('hidden');
    editingRoomId = null;
    selectedRoomStudents = [];
}

// Salvar sala
function saveRoom() {
    const name = document.getElementById('room-name').value;
    const status = document.getElementById('room-status').value;
    
    if (!name.trim()) {
        alert('Por favor, preencha o nome da sala.');
        return;
    }
    
    showLoading();
    
    const roomData = {
        name: name,
        teacherId: currentUser.uid,
        studentIds: selectedRoomStudents,
        status: status,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    
    if (editingRoomId) {
        // Atualizar sala existente
        db.collection('rooms').doc(editingRoomId).update(roomData)
            .then(() => {
                hideLoading();
                closeRoomModal();
                loadProfessorRooms();
                alert('Sala atualizada com sucesso!');
            })
            .catch(error => {
                hideLoading();
                alert('Erro ao atualizar sala: ' + error.message);
            });
    } else {
        // Criar nova sala
        roomData.createdAt = firebase.firestore.FieldValue.serverTimestamp();
        
        db.collection('rooms').add(roomData)
            .then(() => {
                hideLoading();
                closeRoomModal();
                loadProfessorRooms();
                alert('Sala criada com sucesso!');
            })
            .catch(error => {
                hideLoading();
                alert('Erro ao criar sala: ' + error.message);
            });
    }
}

// Excluir sala
function deleteRoom(roomId) {
    if (confirm('Tem certeza que deseja excluir esta sala? Esta ação não pode ser desfeita.')) {
        showLoading();
        
        db.collection('rooms').doc(roomId).delete()
            .then(() => {
                hideLoading();
                loadProfessorRooms();
                alert('Sala excluída com sucesso!');
            })
            .catch(error => {
                hideLoading();
                alert('Erro ao excluir sala: ' + error.message);
            });
    }
}

// Editar aluno do professor
function editProfessorStudent(studentId) {
    alert('Função de edição de aluno em desenvolvimento.');
}

// Alternar status de aluno do professor
function toggleProfessorStudentStatus(studentId, currentStatus) {
    const newStatus = currentStatus === 'active' ? 'inactive' : 'active';
    
    if (confirm(`Tem certeza que deseja ${newStatus === 'active' ? 'ativar' : 'desativar'} este aluno?`)) {
        showLoading();
        
        db.collection('users').doc(studentId).update({
            status: newStatus,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        })
        .then(() => {
            hideLoading();
            loadProfessorStudents();
            alert('Status do aluno atualizado com sucesso!');
        })
        .catch(error => {
            hideLoading();
            alert('Erro ao atualizar status do aluno: ' + error.message);
        });
    }
}

// Editar quiz do professor
function editProfessorQuiz(quizId) {
    alert('Função de edição de quiz em desenvolvimento.');
}

// Excluir quiz do professor
function deleteProfessorQuiz(quizId) {
    if (confirm('Tem certeza que deseja excluir este quiz?')) {
        showLoading();
        
        db.collection('quizzes').doc(quizId).delete()
            .then(() => {
                hideLoading();
                loadProfessorQuizzes();
                alert('Quiz excluído com sucesso!');
            })
            .catch(error => {
                hideLoading();
                alert('Erro ao excluir quiz: ' + error.message);
            });
    }
}

// Filtrar alunos na busca da sala
function filterRoomStudents(query) {
    const studentsList = document.getElementById('room-students-list');
    if (!studentsList) return;
    
    const checkboxes = studentsList.querySelectorAll('.student-checkbox');
    const searchQuery = query.toLowerCase();
    
    checkboxes.forEach(checkbox => {
        const label = checkbox.querySelector('label span');
        if (label) {
            const studentName = label.textContent.toLowerCase();
            if (studentName.includes(searchQuery)) {
                checkbox.style.display = 'block';
            } else {
                checkbox.style.display = 'none';
            }
        }
    });
}
