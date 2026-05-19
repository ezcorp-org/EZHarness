export interface SubConversationState {
  id: string;
  agentConfigId: string;
  agentName: string;
  parentConversationId: string;
  parentMessageId: string;
}

export interface SubConvoMessage {
  id: string;
  role: string;
  content: string;
  createdAt: Date;
}

class SubConversationStore {
  activeSubConversation = $state<SubConversationState | null>(null);
  subConvoMessages = $state<SubConvoMessage[]>([]);
  isStreaming = $state(false);

  get isInSubConversation(): boolean {
    return this.activeSubConversation !== null;
  }

  get activeSubConversationId(): string | null {
    return this.activeSubConversation?.id ?? null;
  }

  startSubConversation(opts: SubConversationState): void {
    this.activeSubConversation = opts;
    this.subConvoMessages = [];
    this.isStreaming = false;
  }

  endSubConversation(): SubConvoMessage[] {
    const messages = this.subConvoMessages;
    this.activeSubConversation = null;
    this.subConvoMessages = [];
    this.isStreaming = false;
    return messages;
  }

  addMessage(msg: SubConvoMessage): void {
    this.subConvoMessages = [...this.subConvoMessages, msg];
  }

  setStreaming(streaming: boolean): void {
    this.isStreaming = streaming;
  }
}

export const subConversationStore = new SubConversationStore();
