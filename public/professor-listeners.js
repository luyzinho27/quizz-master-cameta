// Listeners para o Professor

// Modal de sala
if (document.getElementById('close-room-modal')) {
    document.getElementById('close-room-modal').addEventListener('click', closeRoomModal);
}

if (document.getElementById('cancel-room')) {
    document.getElementById('cancel-room').addEventListener('click', closeRoomModal);
}

if (document.getElementById('save-room')) {
    document.getElementById('save-room').addEventListener('click', saveRoom);
}

if (document.getElementById('room-student-search')) {
    document.getElementById('room-student-search').addEventListener('input', function() {
        filterRoomStudents(this.value);
    });
}
