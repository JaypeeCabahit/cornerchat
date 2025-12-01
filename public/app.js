const clientId = window.crypto?.randomUUID?.() ?? `client-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const PROFILE_STORAGE_KEY = 'the-corner-profile';
const AVATAR_FILE_LIMIT = 5 * 1024 * 1024; // 5 MB
const notificationSound = new Audio('/audio/notification.mp3');
const connectSound = new Audio('/audio/connect.mp3');
const disconnectSound = new Audio('/audio/disconnect.ogg');

const refs = {
  form: document.getElementById('startForm'),
  nickname: document.getElementById('nickname'),
  interests: document.querySelectorAll('.interests input[type="checkbox"]'),
  avatarUpload: document.getElementById('avatarUpload'),
  avatarPreview: document.getElementById('avatarPreview'),
  removeAvatarBtn: document.getElementById('removeAvatarBtn'),
  rulesCheck: document.getElementById('rulesCheck'),
  startBtn: document.getElementById('startBtn'),
  statusText: document.getElementById('statusText'),
  chatWindow: document.getElementById('chatWindow'),
  messageInput: document.getElementById('messageInput'),
  sendBtn: document.getElementById('sendBtn'),
  nextBtn: document.getElementById('nextBtn'),
  disconnectBtn: document.getElementById('disconnectBtn'),
  connectBtn: document.getElementById('connectBtn'),
  blockBtn: document.getElementById('blockBtn'),
  reportBtn: document.getElementById('reportBtn'),
  blockModal: document.getElementById('blockModal'),
  closeBlockModal: document.getElementById('closeBlockModal'),
  cancelBlockBtn: document.getElementById('cancelBlockBtn'),
  confirmBlockBtn: document.getElementById('confirmBlockBtn'),
  typingIndicator: document.getElementById('typingIndicator'),
  typingText: document.getElementById('typingText'),
  onlineCount: document.getElementById('onlineCount'),
  themeToggle: document.getElementById('themeToggle'),
  partnerInfo: document.getElementById('partnerInfo'),
  partnerAvatar: document.getElementById('partnerAvatar'),
  profileCard: document.getElementById('profileCard'),
  profileNickname: document.getElementById('profileNickname'),
  profileCountry: document.getElementById('profileCountry'),
  profileAvatar: document.getElementById('profileAvatar'),
  selectedInterests: document.getElementById('selectedInterests'),
  editProfileBtn: document.getElementById('editProfileBtn'),
  editProfileAltBtn: document.getElementById('editProfileAltBtn'),
  chatPanel: document.getElementById('chatPanel'),
  reportModal: document.getElementById('reportModal'),
  reportForm: document.getElementById('reportForm'),
  reportCategory: document.getElementById('reportCategory'),
  reportDetails: document.getElementById('reportDetails'),
  closeReportModal: document.getElementById('closeReportModal'),
  cancelReportBtn: document.getElementById('cancelReportBtn'),
  rulesModal: document.getElementById('rulesModal'),
  openRulesBtn: document.getElementById('openRulesBtn'),
  openRulesFooterBtn: document.getElementById('openRulesFooterBtn'),
  closeRulesModal: document.getElementById('closeRulesModal'),
  ackRulesBtn: document.getElementById('ackRulesBtn'),
  partnerMeta: document.getElementById('partnerMeta')
};

let eventSource;
let currentState = 'idle';
let typingTimeout;
let sentTyping = false;
let stage = document.body.getAttribute('data-stage') || 'intro';
let partnerProfile = null;
let detectedCountryInfo = { name: null, code: null };
let lastNotificationTime = 0;
const blockedUsers = new Set(); // Temporary block list (resets on refresh)
let activeProfile = {
  nickname: 'Stranger',
  interests: [],
  countryName: null,
  countryCode: null,
  avatarImage: null
};

loadProfileFromStorage();
connectToStream();
restoreTheme();
initCountryDetection();
updateAvatarPreview();
updateProfileSummary();
updateControls();
if (stage === 'intro') {
  clearChat('Set your nickname and photo to join the chat.');
}

refs.avatarPreview?.addEventListener('click', () => refs.avatarUpload?.click());
refs.avatarUpload?.addEventListener('change', handleAvatarUpload);
refs.removeAvatarBtn?.addEventListener('click', () => {
  refs.avatarUpload.value = '';
  setAvatarImage(null);
});

refs.form?.addEventListener('submit', (event) => {
  event.preventDefault();
  startChat();
});

refs.rulesCheck?.addEventListener('change', handleRulesCheck);

refs.sendBtn?.addEventListener('click', () => sendMessage());
refs.messageInput?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
});

refs.messageInput?.addEventListener('input', () => {
  autoResizeTextarea();
  if (currentState !== 'chatting') return;
  emitTyping(true);
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => emitTyping(false), 900);
});

refs.connectBtn?.addEventListener('click', () => {
  const ready = currentState === 'idle' || currentState === 'partner-left';
  if (refs.connectBtn.disabled || stage !== 'chat' || !ready) return;
  joinWithProfile();
});

refs.nextBtn?.addEventListener('click', () => {
  if (currentState === 'idle') return;
  clearChat('Finding someone friendly for you...', { searching: true });
  postJSON('/next', { clientId });
});

refs.disconnectBtn?.addEventListener('click', () => {
  if (currentState === 'idle') return;
  clearChat('You left the chat. Press Connect when you are ready.');
  postJSON('/disconnect', { clientId });
});

refs.blockBtn?.addEventListener('click', () => {
  if (currentState !== 'chatting') return;
  openBlockModal();
});

refs.reportBtn?.addEventListener('click', () => {
  if (currentState !== 'chatting') return;
  openReportModal();
});

refs.themeToggle?.addEventListener('click', toggleTheme);
[refs.editProfileBtn, refs.editProfileAltBtn].forEach((btn) => {
  btn?.addEventListener('click', () => enterProfileEditor());
});

if (refs.reportForm) {
  refs.reportForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const detail = refs.reportDetails.value.trim();
    const reason = `${refs.reportCategory.value}${detail ? ` - ${detail}` : ''}`;
    await postJSON('/report', { clientId, reason });
    closeReportModal();
    alert('Thanks. The chat has been flagged for review.');
  });
}

[refs.closeReportModal, refs.cancelReportBtn].forEach((btn) => {
  btn?.addEventListener('click', () => closeReportModal());
});

refs.reportModal?.addEventListener('click', (event) => {
  if (event.target === refs.reportModal) {
    closeReportModal();
  }
});

[refs.closeBlockModal, refs.cancelBlockBtn].forEach((btn) => {
  btn?.addEventListener('click', () => closeBlockModal());
});

refs.confirmBlockBtn?.addEventListener('click', () => {
  if (!partnerProfile || !partnerProfile.id) return;

  // Add partner ID to blocked list
  blockedUsers.add(partnerProfile.id);

  closeBlockModal();

  // Disconnect and move to next
  postJSON('/disconnect', { clientId });
  clearChat('User blocked. You won\'t be matched with them again this session.');

  alert('User blocked. You won\'t be matched with them again during this session.');
});

refs.blockModal?.addEventListener('click', (event) => {
  if (event.target === refs.blockModal) {
    closeBlockModal();
  }
});

[refs.openRulesBtn, refs.openRulesFooterBtn].forEach((btn) => btn?.addEventListener('click', () => openRulesModal()));
[refs.closeRulesModal, refs.ackRulesBtn].forEach((btn) => btn?.addEventListener('click', () => closeRulesModal()));
refs.rulesModal?.addEventListener('click', (event) => {
  if (event.target === refs.rulesModal) {
    closeRulesModal();
  }
});

handleRulesCheck();

function handleRulesCheck() {
  if (!refs.startBtn) return;
  const allowed = Boolean(refs.rulesCheck?.checked);
  refs.startBtn.disabled = !allowed;
}

function connectToStream() {
  if (eventSource) {
    eventSource.close();
  }

  eventSource = new EventSource(`/events?clientId=${clientId}`);

  eventSource.addEventListener('connected', () => {
    updateStatus('Connected. Press Connect when you are ready.');
  });

  eventSource.addEventListener('status', (event) => {
    const payload = parse(event.data);
    currentState = payload?.state ?? currentState;
    if (currentState !== 'chatting') {
      sentTyping = false;
      refs.typingIndicator?.classList.remove('visible');
    }
    updateStatus(payload?.message ?? '');
    if (payload?.state === 'waiting') {
      clearChat(payload.message || 'Finding someone friendly for you...', { searching: true });
    }
    if (payload?.state === 'idle') {
      updatePartnerInfo(null);
      clearChat('Press Connect when you are ready.');
    }
    if (payload?.state === 'chatting') {
      clearChat();
    }
    if (payload?.state === 'partner-left') {
      showSystemMessage('Chat ended', payload.message);
      updatePartnerInfo(null);
      try {
        disconnectSound.play().catch(err => console.log('Disconnect sound failed:', err));
      } catch (err) {
        console.log('Disconnect sound error:', err);
      }
    }
    updateControls();
  });

  eventSource.addEventListener('message', (event) => {
    const payload = parse(event.data);
    if (!payload) return;
    addMessage(payload);
    if (payload.author !== 'you') {
      const now = Date.now();
      if (now - lastNotificationTime > 500) {
        lastNotificationTime = now;
        try {
          notificationSound.currentTime = 0;
          notificationSound.play().catch(err => console.log('Sound play failed:', err));
        } catch (err) {
          console.log('Sound error:', err);
        }
      }
    }
  });

  eventSource.addEventListener('typing', (event) => {
    const payload = parse(event.data);
    const isTyping = Boolean(payload?.typing && currentState === 'chatting');
    refs.typingIndicator?.classList.toggle('visible', isTyping);
    if (isTyping && partnerProfile) {
      const partnerName = partnerProfile.nickname || 'Stranger';
      refs.typingText.textContent = `${partnerName} is typing`;
    }
  });

  eventSource.addEventListener('partner', (event) => {
    const payload = parse(event.data);
    updatePartnerInfo(payload || null);
    if (payload?.nickname) {
      showSystemMessage('Connected', `You are now chatting with ${payload.nickname}.`);
      try {
        connectSound.play().catch(err => console.log('Connect sound failed:', err));
      } catch (err) {
        console.log('Connect sound error:', err);
      }
    }
  });

  eventSource.addEventListener('online', (event) => {
    const payload = parse(event.data);
    refs.onlineCount.textContent = `${payload?.count ?? 0} online`;
  });

  eventSource.addEventListener('reaction', (event) => {
    const payload = parse(event.data);
    if (payload && payload.messageId && payload.emoji) {
      // Partner sent a reaction
      if (!messageReactions.has(payload.messageId)) {
        messageReactions.set(payload.messageId, {});
      }
      const reactions = messageReactions.get(payload.messageId);

      if (payload.remove) {
        if (reactions[payload.emoji]) {
          reactions[payload.emoji]--;
          if (reactions[payload.emoji] <= 0) {
            delete reactions[payload.emoji];
          }
        }
      } else {
        reactions[payload.emoji] = (reactions[payload.emoji] || 0) + 1;
      }

      displayReactions(payload.messageId, reactions);
    }
  });

  eventSource.onerror = () => {
    updateStatus('Connection lost. Reconnecting...');
    setTimeout(() => {
      if (eventSource.readyState === EventSource.CLOSED) {
        connectToStream();
      }
    }, 3000);
  };
}

function startChat() {
  if (!refs.rulesCheck.checked) {
    alert('Please agree to the house rules first.');
    return;
  }

  const nickname = refs.nickname.value.trim();
  const interests = Array.from(refs.interests)
    .filter((box) => box.checked)
    .map((box) => box.value);

  activeProfile.nickname = nickname || 'Stranger';
  activeProfile.interests = interests;
  activeProfile.countryName = detectedCountryInfo.name || activeProfile.countryName || 'Unknown';
  activeProfile.countryCode = detectedCountryInfo.code || activeProfile.countryCode;

  refs.startBtn.disabled = true;
  updateProfileSummary();
  saveProfileToStorage();
  setStage('chat');
  updateStatus('Profile saved. Press Connect when you are ready.');
  clearChat('Press Connect when you are ready.');
  updateControls();
refs.startBtn.disabled = false;
}

function joinWithProfile() {
  if (!activeProfile.countryName || activeProfile.countryName === 'Unknown') {
    activeProfile.countryName = detectedCountryInfo.name || 'Unknown';
  }
  if (!activeProfile.countryCode) {
    activeProfile.countryCode = detectedCountryInfo.code || null;
  }
  const payload = {
    clientId,
    nickname: activeProfile.nickname || 'Stranger',
    interests: activeProfile.interests || [],
    country: activeProfile.countryName,
    countryCode: activeProfile.countryCode,
    avatarImage: activeProfile.avatarImage
  };
  currentState = 'waiting';
  updateControls();
  clearChat('Finding someone friendly for you...', { searching: true });
  return postJSON('/start', payload);
}

function sendMessage() {
  if (currentState !== 'chatting') return;
  const text = refs.messageInput.value.trim();
  if (!text) return;

  refs.messageInput.value = '';
  autoResizeTextarea();
  emitTyping(false);
  postJSON('/message', { clientId, message: text });
}

function emitTyping(isTyping) {
  if (sentTyping === isTyping) return;
  sentTyping = isTyping;
  postJSON('/typing', { clientId, typing: isTyping });
}

async function postJSON(url, payload) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      console.error('Request failed', url);
    }
  } catch (err) {
    console.error('Network error', err);
  }
}

function updateStatus(text) {
  refs.statusText.textContent = text;
}

function updateControls() {
  const chatting = currentState === 'chatting';
  const waiting = currentState === 'waiting';
  const idle = currentState === 'idle' || currentState === 'partner-left';
  refs.messageInput.disabled = !chatting;
  refs.sendBtn.disabled = !chatting;
  refs.nextBtn.disabled = !(chatting || waiting);
  refs.disconnectBtn.disabled = !chatting && !waiting;
  refs.blockBtn.disabled = !chatting;
  refs.reportBtn.disabled = !chatting;

  if (!refs.connectBtn) return;
  if (waiting) {
    refs.connectBtn.disabled = true;
    refs.connectBtn.textContent = 'Searching...';
  } else if (chatting) {
    refs.connectBtn.disabled = true;
    refs.connectBtn.textContent = 'Connected';
  } else {
    refs.connectBtn.disabled = !(stage === 'chat' && idle);
    refs.connectBtn.textContent = 'Connect';
  }
}

function addMessage(payload) {
  const role = payload.author === 'you' ? 'you' : 'stranger';
  const messageWrapper = document.createElement('div');
  messageWrapper.className = `message-wrapper ${role}`;
  const messageId = payload.messageId || `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  messageWrapper.dataset.messageId = messageId;

  const nickname = role === 'you' ? 'You' : (payload.author || 'Stranger');
  const timestamp = payload.timestamp
    ? new Date(payload.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '';

  if (role !== 'you' && partnerProfile) {
    const avatarEl = document.createElement('div');
    avatarEl.className = 'message-avatar avatar-pill sm';
    applyAvatarImage(avatarEl, partnerProfile.avatarImage, nickname.charAt(0).toUpperCase());
    messageWrapper.appendChild(avatarEl);
  }

  const bubble = document.createElement('div');
  bubble.className = `message ${role}`;
  if (timestamp) {
    bubble.title = timestamp;
  }
  bubble.innerHTML = `<div class="message-text">${formatMessageHtml(payload.text || '')}</div>`;

  // Add reaction trigger button
  const reactionTrigger = document.createElement('div');
  reactionTrigger.className = 'reaction-trigger';
  reactionTrigger.innerHTML = '😊';
  reactionTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    showReactionPicker(messageWrapper, messageId);
  });

  // Add reaction picker
  const reactionPicker = document.createElement('div');
  reactionPicker.className = 'reaction-picker';
  reactionPicker.innerHTML = `
    <span class="reaction-emoji" data-emoji="❤️">❤️</span>
    <span class="reaction-emoji" data-emoji="😂">😂</span>
    <span class="reaction-emoji" data-emoji="😮">😮</span>
    <span class="reaction-emoji" data-emoji="😢">😢</span>
    <span class="reaction-emoji" data-emoji="😡">😡</span>
    <span class="reaction-emoji" data-emoji="👍">👍</span>
    <div class="reaction-add">+</div>
  `;

  reactionPicker.querySelectorAll('.reaction-emoji').forEach(emoji => {
    emoji.addEventListener('click', (e) => {
      e.stopPropagation();
      addReaction(messageId, emoji.dataset.emoji);
      hideReactionPicker(messageWrapper);
    });
  });

  reactionPicker.querySelector('.reaction-add').addEventListener('click', (e) => {
    e.stopPropagation();
    hideReactionPicker(messageWrapper);
    openEmojiPicker(messageId);
  });

  // Add reactions container
  const reactionsContainer = document.createElement('div');
  reactionsContainer.className = 'message-reactions';

  // Add long-press support for mobile
  let pressTimer;
  bubble.addEventListener('touchstart', (e) => {
    pressTimer = setTimeout(() => {
      showReactionPicker(messageWrapper, messageId);
    }, 500); // 500ms long-press
  });

  bubble.addEventListener('touchend', () => {
    clearTimeout(pressTimer);
  });

  bubble.addEventListener('touchmove', () => {
    clearTimeout(pressTimer);
  });

  // Append reaction trigger to bubble (so it positions relative to bubble)
  bubble.appendChild(reactionTrigger);

  // Create inner container for bubble and reactions
  const messageContent = document.createElement('div');
  messageContent.className = 'message-content';
  messageContent.appendChild(bubble);
  messageContent.appendChild(reactionPicker);
  messageContent.appendChild(reactionsContainer);

  messageWrapper.appendChild(messageContent);

  refs.chatWindow.querySelector('.placeholder')?.remove();
  refs.chatWindow.classList.remove('searching');

  messageWrapper.style.opacity = '0';
  messageWrapper.style.transform = 'translateY(10px)';
  refs.chatWindow.appendChild(messageWrapper);

  requestAnimationFrame(() => {
    messageWrapper.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
    messageWrapper.style.opacity = '1';
    messageWrapper.style.transform = 'translateY(0)';
  });

  refs.chatWindow.scrollTop = refs.chatWindow.scrollHeight;

  // Load existing reactions if any
  if (payload.reactions) {
    displayReactions(messageId, payload.reactions);
  }
}

function showSystemMessage(title, detail) {
  if (!detail) return;
  const bubble = document.createElement('div');
  bubble.className = 'message stranger';
  bubble.innerHTML = `<strong>${title}</strong><div>${formatMessageHtml(detail)}</div>`;
  refs.chatWindow.querySelector('.placeholder')?.remove();
  refs.chatWindow.classList.remove('searching');
  refs.chatWindow.appendChild(bubble);
  refs.chatWindow.scrollTop = refs.chatWindow.scrollHeight;
}

function clearChat(message, options = {}) {
  const { searching = false } = options;
  refs.chatWindow.classList.toggle('searching', Boolean(searching));
  const dots = searching
    ? `<div class="searching-dots"><span></span><span></span><span></span></div>`
    : '';
  refs.chatWindow.innerHTML = `
    <div class="placeholder${searching ? ' searching' : ''}">
      <p>${message || getChatPlaceholder()}</p>
      ${dots}
    </div>
  `;
  if (!searching) {
    refs.chatWindow.classList.remove('searching');
  }
}

function getChatPlaceholder() {
  if (stage === 'intro') {
    return 'Set your nickname and photo to join the chat.';
  }
  if (currentState === 'waiting') {
    return 'Finding someone friendly for you...';
  }
  if (currentState === 'idle' || currentState === 'partner-left') {
    return 'Press Connect when you are ready.';
  }
  return 'Say hi to your partner!';
}

// Reaction management
const messageReactions = new Map(); // messageId -> { emoji -> count }
const userReactions = new Map(); // messageId -> emoji (user's current reaction)
let currentEmojiPickerMessageId = null;

function showReactionPicker(messageWrapper, messageId) {
  // Hide all other pickers first
  document.querySelectorAll('.reaction-picker.visible').forEach(p => p.classList.remove('visible'));

  const picker = messageWrapper.querySelector('.reaction-picker');
  if (picker) {
    picker.classList.add('visible');
  }
}

function hideReactionPicker(messageWrapper) {
  const picker = messageWrapper.querySelector('.reaction-picker');
  if (picker) {
    picker.classList.remove('visible');
  }
}

function addReaction(messageId, emoji) {
  if (!emoji) return;

  // Check if user already has a reaction on this message
  const currentReaction = userReactions.get(messageId);

  if (currentReaction === emoji) {
    // Same emoji - remove it
    removeReaction(messageId, emoji);
    return;
  }

  // Remove old reaction if exists
  if (currentReaction) {
    const reactions = messageReactions.get(messageId);
    if (reactions && reactions[currentReaction]) {
      reactions[currentReaction]--;
      if (reactions[currentReaction] <= 0) {
        delete reactions[currentReaction];
      }
      sendReactionToServer(messageId, currentReaction, true);
    }
  }

  // Add new reaction
  if (!messageReactions.has(messageId)) {
    messageReactions.set(messageId, {});
  }
  const reactions = messageReactions.get(messageId);
  reactions[emoji] = (reactions[emoji] || 0) + 1;

  // Track user's reaction
  userReactions.set(messageId, emoji);

  // Update UI
  displayReactions(messageId, reactions);

  // Send to server
  sendReactionToServer(messageId, emoji);
}

function removeReaction(messageId, emoji) {
  if (!messageReactions.has(messageId)) return;

  const reactions = messageReactions.get(messageId);
  if (reactions[emoji]) {
    reactions[emoji]--;
    if (reactions[emoji] <= 0) {
      delete reactions[emoji];
    }
  }

  // Remove user's reaction tracking
  userReactions.delete(messageId);

  displayReactions(messageId, reactions);
  sendReactionToServer(messageId, emoji, true);
}

function displayReactions(messageId, reactions) {
  const messageWrapper = refs.chatWindow.querySelector(`[data-message-id="${messageId}"]`);
  if (!messageWrapper) return;

  const container = messageWrapper.querySelector('.message-reactions');
  if (!container) return;

  container.innerHTML = '';

  const userReaction = userReactions.get(messageId);

  Object.entries(reactions).forEach(([emoji, count]) => {
    if (count > 0) {
      const reactionEl = document.createElement('div');
      reactionEl.className = 'message-reaction';

      // Highlight if this is user's reaction
      if (emoji === userReaction) {
        reactionEl.classList.add('reacted');
      }

      reactionEl.innerHTML = `
        <span class="emoji">${emoji}</span>
        <span class="count">${count}</span>
      `;
      reactionEl.addEventListener('click', () => {
        // Click to add/remove reaction
        addReaction(messageId, emoji);
      });
      container.appendChild(reactionEl);
    }
  });
}

function sendReactionToServer(messageId, emoji, remove = false) {
  // Send reaction to server to sync with partner
  fetch('/reaction', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId,
      messageId,
      emoji,
      remove
    })
  }).catch(err => console.error('Failed to send reaction:', err));
}

// Close reaction picker when clicking outside
document.addEventListener('click', () => {
  document.querySelectorAll('.reaction-picker.visible').forEach(p => {
    p.classList.remove('visible');
  });
});

// Emoji picker modal
function openEmojiPicker(messageId) {
  currentEmojiPickerMessageId = messageId;

  // Check if modal already exists
  let modal = document.getElementById('emojiPickerModal');
  if (!modal) {
    modal = createEmojiPickerModal();
    document.body.appendChild(modal);
  }

  modal.classList.add('visible');
}

function closeEmojiPicker() {
  const modal = document.getElementById('emojiPickerModal');
  if (modal) {
    modal.classList.remove('visible');
  }
  currentEmojiPickerMessageId = null;
}

function createEmojiPickerModal() {
  const modal = document.createElement('div');
  modal.id = 'emojiPickerModal';
  modal.className = 'emoji-picker-modal';

  const emojis = [
    '😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '🙃', '😉', '😊',
    '😇', '🥰', '😍', '🤩', '😘', '😗', '😚', '😙', '😋', '😛', '😜', '🤪',
    '😝', '🤑', '🤗', '🤭', '🤫', '🤔', '🤐', '🤨', '😐', '😑', '😶', '😏',
    '😒', '🙄', '😬', '🤥', '😌', '😔', '😪', '🤤', '😴', '😷', '🤒', '🤕',
    '🤢', '🤮', '🤧', '🥵', '🥶', '😶‍🌫️', '🥴', '😵', '🤯', '🤠', '🥳', '😎',
    '🤓', '🧐', '😕', '😟', '🙁', '☹️', '😮', '😯', '😲', '😳', '🥺', '😦',
    '😧', '😨', '😰', '😥', '😢', '😭', '😱', '😖', '😣', '😞', '😓', '😩',
    '😫', '🥱', '😤', '😡', '😠', '🤬', '😈', '👿', '💀', '☠️', '💩', '🤡',
    '👹', '👺', '👻', '👽', '👾', '🤖', '😺', '😸', '😹', '😻', '😼', '😽',
    '🙀', '😿', '😾', '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎',
    '💔', '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💟', '☮️', '✝️',
    '☪️', '🕉️', '☸️', '✡️', '🔯', '🕎', '☯️', '☦️', '🛐', '⛎', '♈', '♉',
    '👍', '👎', '👊', '✊', '🤛', '🤜', '🤞', '✌️', '🤟', '🤘', '👌', '🤏',
    '👈', '👉', '👆', '👇', '☝️', '✋', '🤚', '🖐️', '🖖', '👋', '🤙', '💪',
    '🦾', '🖕', '✍️', '🙏', '🦶', '🦵', '🦿', '💄', '💋', '👄', '🦷', '👅'
  ];

  modal.innerHTML = `
    <div class="emoji-picker-grid">
      <h3>Pick an emoji</h3>
      <div class="emoji-grid">
        ${emojis.map(emoji => `<div class="emoji-grid-item" data-emoji="${emoji}">${emoji}</div>`).join('')}
      </div>
    </div>
  `;

  // Close when clicking outside
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      closeEmojiPicker();
    }
  });

  // Add click handlers to emoji items
  modal.querySelectorAll('.emoji-grid-item').forEach(item => {
    item.addEventListener('click', () => {
      const emoji = item.dataset.emoji;
      if (currentEmojiPickerMessageId) {
        addReaction(currentEmojiPickerMessageId, emoji);
      }
      closeEmojiPicker();
    });
  });

  return modal;
}

function autoResizeTextarea() {
  if (!refs.messageInput) return;
  const el = refs.messageInput;
  el.style.height = 'auto';
  const maxHeight = 150;
  const minHeight = 44;
  const newHeight = Math.min(maxHeight, Math.max(minHeight, el.scrollHeight));
  el.style.height = `${newHeight}px`;
  el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
}

function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case '\'':
        return '&#39;';
      default:
        return char;
    }
  });
}

function formatMessageHtml(text) {
  return escapeHtml(text).replace(/\n/g, '<br>');
}

function toggleTheme() {
  const current = document.body.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  const next = current === 'dark' ? 'light' : 'dark';
  document.body.setAttribute('data-theme', next);
  refs.themeToggle.textContent = next === 'dark' ? '🌙' : '☀️';
  localStorage.setItem('randomtext-theme', next);
}

function restoreTheme() {
  const stored = localStorage.getItem('randomtext-theme');
  if (stored) {
    document.body.setAttribute('data-theme', stored);
    refs.themeToggle.textContent = stored === 'dark' ? '🌙' : '☀️';
  }
}

function enterProfileEditor() {
  postJSON('/disconnect', { clientId });
  setStage('intro');
  currentState = 'idle';
  updateStatus('Edit your profile, then save and press Connect.');
  updatePartnerInfo(null);
  clearChat('Set your nickname and photo to join the chat.');
  updateControls();
  syncFormWithProfile();
  closeReportModal();
  closeRulesModal();
  handleRulesCheck();
}

function openReportModal() {
  if (!refs.reportModal) return;
  refs.reportModal.classList.add('visible');
  if (refs.reportDetails) refs.reportDetails.value = '';
  if (refs.reportCategory) {
    refs.reportCategory.value = refs.reportCategory.querySelector('option')?.value || 'spam';
  }
}

function closeReportModal() {
  if (!refs.reportModal) return;
  refs.reportModal.classList.remove('visible');
}

function openBlockModal() {
  if (!refs.blockModal) return;
  refs.blockModal.classList.add('visible');
}

function closeBlockModal() {
  if (!refs.blockModal) return;
  refs.blockModal.classList.remove('visible');
}

function openRulesModal() {
  if (!refs.rulesModal) return;
  refs.rulesModal.classList.add('visible');
}

function closeRulesModal() {
  if (!refs.rulesModal) return;
  refs.rulesModal.classList.remove('visible');
}

function setStage(nextStage) {
  if (stage === nextStage) return;
  stage = nextStage;
  document.body.setAttribute('data-stage', nextStage);
  if (nextStage === 'intro') {
    if (refs.chatPanel) refs.chatPanel.style.display = 'none';
    clearChat('Set your nickname and photo to join the chat.');
  } else {
    if (refs.chatPanel) refs.chatPanel.style.display = '';
  }
}

async function initCountryDetection() {
  try {
    const info = await detectCountry();
    if (info) {
      detectedCountryInfo = info;
      const shouldAdopt =
        !activeProfile.countryName || activeProfile.countryName === 'Unknown';
      if (shouldAdopt) {
        activeProfile.countryName = info.name;
        activeProfile.countryCode = info.code;
        updateProfileSummary();
        saveProfileToStorage();
      }
    }
  } catch (err) {
    console.warn('Country detection failed', err);
  }
}

async function detectCountry() {
  try {
    const res = await fetch('https://ipapi.co/json/', { cache: 'no-store' });
    if (!res.ok) throw new Error('Failed to fetch location');
    const data = await res.json();
    const code = (data.country_code || data.country || '').toUpperCase() || null;
    const name = data.country_name || data.country || null;
    if (!name && !code) return fallbackCountry();
    return { name: name || code, code };
  } catch {
    return fallbackCountry();
  }
}

function fallbackCountry() {
  const localeString = navigator.languages?.[0] || navigator.language;
  if (!localeString) return null;
  try {
    let locale = new Intl.Locale(localeString);
    if (locale.maximize) {
      locale = locale.maximize();
    }
    const region = locale.region || null;
    if (!region) return null;
    const display = new Intl.DisplayNames([locale.language || 'en'], { type: 'region' });
    return {
      name: display.of(region) || region,
      code: region
    };
  } catch {
    return null;
  }
}

function updateProfileSummary() {
  refs.profileNickname.textContent = activeProfile.nickname || 'Stranger';
  const countryName = activeProfile.countryName || detectedCountryInfo.name;
  const countryCode = activeProfile.countryCode || detectedCountryInfo.code;
  const countryLabel = formatCountryLabel(countryName, countryCode);
  refs.profileCountry.textContent = countryLabel || 'Detecting location...';
  const fallbackInitial = (activeProfile.nickname || 'S').charAt(0).toUpperCase();
  applyAvatarImage(refs.profileAvatar, activeProfile.avatarImage, fallbackInitial);
  renderInterestChips(activeProfile.interests);
}

function renderInterestChips(interests = []) {
  const container = refs.selectedInterests;
  container.innerHTML = '';
  if (!interests.length) {
    container.classList.add('muted');
    container.textContent = 'No tags selected';
    return;
  }
  container.classList.remove('muted');
  interests.forEach((interest) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = interest;
    container.appendChild(chip);
  });
}

function formatCountryLabel(name, code) {
  const hasName = Boolean(name);
  const hasCode = Boolean(code);
  if (!hasName && !hasCode) {
    return '🌐 Unknown location';
  }
  const flag = countryCodeToFlag(code);
  return `${flag ? flag + ' ' : ''}${name || code || 'Unknown'}`;
}

function countryCodeToFlag(code) {
  if (!code || code.length !== 2) return '';
  return code
    .toUpperCase()
    .replace(/./g, (char) => String.fromCodePoint(127397 + char.charCodeAt(0)));
}

function updatePartnerInfo(partner) {
  partnerProfile = partner;
  if (!partner) {
    refs.partnerAvatar.style.display = 'none';
    refs.partnerInfo.textContent =
      stage === 'chat'
        ? 'Press Connect when you are ready for a new partner.'
        : "Your partner's nickname and vibe will appear here once you're matched.";
    if (refs.partnerMeta) {
      refs.partnerMeta.textContent = '';
    }
    return;
  }

  // Check if this partner is blocked
  if (partner.id && blockedUsers.has(partner.id)) {
    // Auto-skip blocked user
    postJSON('/next', { clientId });
    clearChat('Matched with a blocked user. Finding a new partner...');
    return;
  }
  refs.partnerAvatar.style.display = '';
  const nickname = partner.nickname || 'Stranger';
  const label = formatCountryLabel(partner.country, partner.countryCode);
  refs.partnerInfo.textContent = `${nickname} · ${label}`;
  if (refs.partnerMeta) {
    refs.partnerMeta.textContent =
      partner.interests && partner.interests.length
        ? `Vibe tags: ${partner.interests.join(', ')}`
        : 'No vibe tags shared yet.';
  }
  applyAvatarImage(refs.partnerAvatar, partner.avatarImage || partner.avatar || null, nickname.charAt(0).toUpperCase());
}

function syncFormWithProfile() {
  refs.nickname.value = activeProfile.nickname === 'Stranger' ? '' : activeProfile.nickname;
  const selected = new Set(activeProfile.interests || []);
  refs.interests.forEach((box) => {
    box.checked = selected.has(box.value);
  });
  updateAvatarPreview();
}

function handleAvatarUpload(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    alert('Please choose an image file.');
    event.target.value = '';
    return;
  }

  refs.avatarPreview.classList.add('skeleton');

  const reader = new FileReader();
  reader.onload = () => {
    resizeAndSetAvatar(reader.result);
    event.target.value = '';
  };
  reader.onerror = () => {
    refs.avatarPreview.classList.remove('skeleton');
    alert('Failed to read the image file. Please try again.');
    event.target.value = '';
  };
  reader.readAsDataURL(file);
}

function resizeAndSetAvatar(dataUrl) {
  const img = new Image();

  img.onerror = () => {
    refs.avatarPreview.classList.remove('skeleton');
    alert('Unable to process this image. Please try a different image file.');
  };

  img.onload = () => {
    try {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: false });

      if (!ctx) {
        throw new Error('Unable to get canvas context');
      }

      const maxSize = 800;
      let width = img.width;
      let height = img.height;

      if (width > height) {
        if (width > maxSize) {
          height = (height * maxSize) / width;
          width = maxSize;
        }
      } else {
        if (height > maxSize) {
          width = (width * maxSize) / height;
          height = maxSize;
        }
      }

      canvas.width = width;
      canvas.height = height;

      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, width, height);

      let quality = 0.8;
      let resizedDataUrl = canvas.toDataURL('image/jpeg', quality);
      const maxBase64Size = 8 * 1024 * 1024;

      if (resizedDataUrl.length > maxBase64Size) {
        quality = 0.6;
        resizedDataUrl = canvas.toDataURL('image/jpeg', quality);
      }

      if (resizedDataUrl.length > maxBase64Size) {
        quality = 0.4;
        resizedDataUrl = canvas.toDataURL('image/jpeg', quality);
      }

      if (resizedDataUrl.length > maxBase64Size) {
        refs.avatarPreview.classList.remove('skeleton');
        alert('Image is still too large after resizing and compression. Please choose a smaller image.');
        return;
      }

      refs.avatarPreview.classList.remove('skeleton');
      setAvatarImage(resizedDataUrl);
    } catch (err) {
      refs.avatarPreview.classList.remove('skeleton');
      console.error('Error processing image:', err);
      alert('Failed to process the image. Please try a different file.');
    }
  };

  img.src = dataUrl;
}

function setAvatarImage(dataUrl) {
  activeProfile.avatarImage = dataUrl || null;
  updateAvatarPreview();
  updateProfileSummary();
  saveProfileToStorage();
}

function updateAvatarPreview() {
  if (!refs.avatarPreview) return;
  if (activeProfile.avatarImage) {
    refs.avatarPreview.classList.add('has-image');
    refs.avatarPreview.style.backgroundImage = `url('${activeProfile.avatarImage}')`;
  } else {
    refs.avatarPreview.classList.remove('has-image');
    refs.avatarPreview.style.backgroundImage = 'none';
  }
}

function applyAvatarImage(target, dataUrl, fallbackText = '') {
  if (!target) return;
  if (dataUrl) {
    target.classList.add('has-image');
    target.style.backgroundImage = `url('${dataUrl}')`;
    target.textContent = '';
  } else {
    target.classList.remove('has-image');
    target.style.backgroundImage = 'none';
    target.textContent = fallbackText;
  }
}

function saveProfileToStorage() {
  try {
    const payload = {
      nickname: activeProfile.nickname,
      interests: activeProfile.interests,
      countryName: activeProfile.countryName,
      countryCode: activeProfile.countryCode,
      avatarImage: activeProfile.avatarImage
    };
    localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(payload));
  } catch (err) {
    console.warn('Unable to save profile locally', err);
  }
}

function loadProfileFromStorage() {
  try {
    const raw = localStorage.getItem(PROFILE_STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    activeProfile = {
      nickname: saved.nickname || activeProfile.nickname,
      interests: Array.isArray(saved.interests) ? saved.interests : [],
      countryName: saved.countryName || activeProfile.countryName,
      countryCode: saved.countryCode || activeProfile.countryCode,
      avatarImage: saved.avatarImage || null
    };
    syncFormWithProfile();
  } catch (err) {
    console.warn('Unable to load saved profile', err);
  }
}
