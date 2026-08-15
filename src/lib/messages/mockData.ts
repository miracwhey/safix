import type { Conversation, Message } from './types'

export const conversationsMock: Conversation[] = [
  {
    id: 'thread_1',
    projectId: 'project-1',
    customerName: 'Leon',
    customerAvatarUrl:
      'https://images.pexels.com/photos/220453/pexels-photo-220453.jpeg?auto=compress&cs=tinysrgb&w=300',
    craftsmanName: 'Badwerk Nord',
    craftsmanHandle: '@badwerk.nord',
    craftsmanAvatarUrl:
      'https://images.pexels.com/photos/415829/pexels-photo-415829.jpeg?auto=compress&cs=tinysrgb&w=300',
    projectTitle: 'Badrenovierung',
    projectSubtitle: 'Anfrage',
    projectLocation: 'Hamburg',
    projectCostRange: '8.000–12.000 €',
    projectDuration: 'ca. 6–8 Tage',
    projectStatusLabel: 'Anfrage läuft',
    timeLabel: '12:14',
    unreadCount: 1,
  },
  {
    id: 'thread_2',
    projectId: 'project-2',
    customerName: 'Leon',
    customerAvatarUrl:
      'https://images.pexels.com/photos/220453/pexels-photo-220453.jpeg?auto=compress&cs=tinysrgb&w=300',
    craftsmanName: 'Fliese & Form',
    craftsmanHandle: '@flieseundform',
    craftsmanAvatarUrl:
      'https://images.pexels.com/photos/614810/pexels-photo-614810.jpeg?auto=compress&cs=tinysrgb&w=300',
    projectTitle: 'Badrenovierung',
    projectSubtitle: 'Neue Anfrage',
    projectLocation: 'Berlin',
    projectCostRange: '4.900–7.500 €',
    projectDuration: 'ca. 3–5 Tage',
    projectStatusLabel: 'Details offen',
    timeLabel: 'Gestern',
    unreadCount: 0,
  },
  {
    id: 'thread_3',
    projectId: 'project-3',
    customerName: 'Leon',
    customerAvatarUrl:
      'https://images.pexels.com/photos/220453/pexels-photo-220453.jpeg?auto=compress&cs=tinysrgb&w=300',
    craftsmanName: 'Elektro Weber',
    craftsmanHandle: '@elektroweber',
    craftsmanAvatarUrl:
      'https://images.pexels.com/photos/614810/pexels-photo-614810.jpeg?auto=compress&cs=tinysrgb&w=300',
    projectTitle: 'Sicherungskasten Modernisierung',
    projectSubtitle: 'Anfrage',
    projectLocation: 'Hannover',
    projectCostRange: '2.400–3.200 €',
    projectDuration: 'ca. 1–2 Tage',
    projectStatusLabel: 'Fotos angefragt',
    timeLabel: 'Mo',
    unreadCount: 0,
  },

  // ── Incoming project requests (inquiry-origin threads, not yet converted) ─
  {
    id: 'thread_req_1',
    projectId: 'project_req_1',
    customerName: 'Sophie Meier',
    customerAvatarUrl:
      'https://images.pexels.com/photos/1239291/pexels-photo-1239291.jpeg?auto=compress&cs=tinysrgb&w=300',
    craftsmanName: 'Mein Betrieb',
    craftsmanHandle: '@meinbetrieb',
    craftsmanAvatarUrl:
      'https://images.pexels.com/photos/415829/pexels-photo-415829.jpeg?auto=compress&cs=tinysrgb&w=300',
    projectTitle: 'Badezimmer komplett modernisieren',
    projectSubtitle: 'Projektanfrage',
    projectLocation: 'Hamburg',
    projectCostRange: '6.000–9.000 €',
    projectDuration: 'ca. 5–7 Tage',
    projectStatusLabel: 'Anfrage läuft',
    timeLabel: 'Jetzt',
    unreadCount: 2,
    inquiryOrigin: 'project',
    sourceProjectId: 'builder_proj_demo_1',
  },
  {
    id: 'thread_req_2',
    projectId: 'project_req_2',
    customerName: 'Markus Hartmann',
    customerAvatarUrl:
      'https://images.pexels.com/photos/91227/pexels-photo-91227.jpeg?auto=compress&cs=tinysrgb&w=300',
    craftsmanName: 'Mein Betrieb',
    craftsmanHandle: '@meinbetrieb',
    craftsmanAvatarUrl:
      'https://images.pexels.com/photos/415829/pexels-photo-415829.jpeg?auto=compress&cs=tinysrgb&w=300',
    projectTitle: 'Elektro-Anfrage',
    projectSubtitle: 'Neue Anfrage',
    projectLocation: 'Hannover',
    projectCostRange: '1.200–2.000 €',
    projectStatusLabel: 'Anfrage läuft',
    timeLabel: 'Heute',
    unreadCount: 0,
    inquiryOrigin: 'reel',
  },
  {
    id: 'thread_req_3',
    projectId: 'project_req_3',
    customerName: 'Anna Richter',
    customerAvatarUrl:
      'https://images.pexels.com/photos/774909/pexels-photo-774909.jpeg?auto=compress&cs=tinysrgb&w=300',
    craftsmanName: 'Mein Betrieb',
    craftsmanHandle: '@meinbetrieb',
    craftsmanAvatarUrl:
      'https://images.pexels.com/photos/415829/pexels-photo-415829.jpeg?auto=compress&cs=tinysrgb&w=300',
    projectTitle: 'Bodenverlegung Wohnzimmer',
    projectSubtitle: 'Bodenbelag',
    projectLocation: 'Berlin',
    projectCostRange: '2.800–4.500 €',
    projectDuration: 'ca. 2–3 Tage',
    projectStatusLabel: 'Anfrage läuft',
    timeLabel: 'Gestern',
    unreadCount: 0,
    inquiryOrigin: 'profile',
  },
]

export const messagesMock: Message[] = [
  {
    id: 'm_1',
    conversationId: 'thread_1',
    sender: 'user',
    text: 'Hallo, ich interessiere mich für eine Badrenovierung.',
    createdAtLabel: '12:01',
  },
  {
    id: 'm_2',
    conversationId: 'thread_1',
    sender: 'counterparty',
    text: 'Klar, schick mir kurz Maße und ein paar Fotos vom aktuellen Bad.',
    createdAtLabel: '12:05',
  },
  {
    id: 'm_3',
    conversationId: 'thread_1',
    sender: 'user',
    text: 'Mache ich. Ich lade heute Abend alles hoch.',
    createdAtLabel: '12:09',
  },
  {
    id: 'm_4',
    conversationId: 'thread_1',
    sender: 'counterparty',
    text: 'Perfekt. Danach kann ich dir eine grobe Einschätzung geben.',
    createdAtLabel: '12:14',
  },
  {
    id: 'm_5',
    conversationId: 'thread_2',
    sender: 'user',
    text: 'Ich suche moderne Fliesen für mein Bad.',
    createdAtLabel: 'Gestern',
  },
  {
    id: 'm_6',
    conversationId: 'thread_2',
    sender: 'counterparty',
    text: 'Großformat geht, ich würde dir aber zwei Varianten zeigen.',
    createdAtLabel: 'Gestern',
  },
  {
    id: 'm_7',
    conversationId: 'thread_3',
    sender: 'user',
    text: 'Kannst du meinen Sicherungskasten modernisieren?',
    createdAtLabel: 'Mo',
  },
  {
    id: 'm_8',
    conversationId: 'thread_3',
    sender: 'counterparty',
    text: 'Für den Austausch brauche ich noch 2–3 Detailfotos.',
    createdAtLabel: 'Mo',
  },

  // ── Messages for incoming request threads ────────────────────────────────
  // thread_req_1: Sophie – 2 unread, craftsman hasn't replied yet
  {
    id: 'm_req_1_1',
    conversationId: 'thread_req_1',
    sender: 'user',
    text: 'Hallo, ich habe ein konkretes Projekt in Hamburg und möchte Ihr Angebot dafür einholen.\n\n📋 Badezimmer komplett modernisieren\n\nBeschreibung: Komplette Erneuerung mit neuen Fliesen, Sanitär und Beleuchtung.\n\n💶 Budget: 6.000–9.000 €\n📅 Zeitraum: Innerhalb 6 Wochen\n\nIch freue mich auf Ihre Rückmeldung.',
    createdAtLabel: 'Jetzt',
  },
  {
    id: 'm_req_1_2',
    conversationId: 'thread_req_1',
    sender: 'user',
    text: 'Noch eine Ergänzung: Das Bad ist ca. 8 m². Können Sie bitte ein erstes Angebot schicken?',
    createdAtLabel: 'Jetzt',
  },

  // thread_req_2: Markus – craftsman hasn't replied yet (needs_response)
  {
    id: 'm_req_2_1',
    conversationId: 'thread_req_2',
    sender: 'user',
    text: 'Hallo, ich habe Ihren Reel entdeckt und würde gerne mehr erfahren. Ist das in Hannover umsetzbar?',
    createdAtLabel: 'Heute',
  },

  // thread_req_3: Anna – craftsman has replied once (in_conversation)
  {
    id: 'm_req_3_1',
    conversationId: 'thread_req_3',
    sender: 'user',
    text: 'Hallo, ich habe Ihr Profil auf SaFix gesehen und würde gerne ein Projekt mit Ihnen besprechen.',
    createdAtLabel: 'Gestern',
  },
  {
    id: 'm_req_3_2',
    conversationId: 'thread_req_3',
    sender: 'counterparty',
    text: 'Guten Tag! Ich schaue mir das gerne an. Können Sie mir noch die genaue Fläche mitteilen?',
    createdAtLabel: 'Gestern',
  },
]
