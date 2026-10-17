/** Online Dərs və Qeyd İnteqrasiyası: teacher settings panel for Google Meet / Zoom connections. Tuple order: [az, en, ru]. */
export const lessons = {
  "lessons.settings.title": ["Onlayn dərs platformaları", "Online lesson platforms", "Платформы для онлайн-уроков"],
  "lessons.settings.description": [
    "Google Meet və ya Zoom hesabınızı qoşun ki, dərs yaradanda görüş avtomatik yaransın. Transkript, qeyd və AI xülasə provayderin öz saxlama müddəti bitməzdən əvvəl Resulio-da da saxlanılır.",
    "Connect your Google Meet or Zoom account so a meeting is created automatically when you schedule a lesson. The transcript, recording and AI summary are also kept in Resulio before the provider's own retention window runs out.",
    "Подключите аккаунт Google Meet или Zoom, чтобы при создании урока встреча создавалась автоматически. Транскрипт, запись и AI-резюме также сохраняются в Resulio до истечения срока хранения у провайдера.",
  ],
  "lessons.provider.googleMeet": ["Google Meet", "Google Meet", "Google Meet"],
  "lessons.provider.zoom": ["Zoom", "Zoom", "Zoom"],
  "lessons.settings.connected": ["Qoşulub", "Connected", "Подключено"],
  "lessons.settings.notConnected": ["Qoşulmayıb", "Not connected", "Не подключено"],
  "lessons.settings.errorStatus": ["Xəta var, yenidən qoşulun", "There's an error, reconnect", "Ошибка, переподключитесь"],
  "lessons.settings.connectedAs": ["Hesab: {email}", "Account: {email}", "Аккаунт: {email}"],
  "lessons.settings.connect": ["Qoşul", "Connect", "Подключить"],
  "lessons.settings.disconnect": ["Əlaqəni kəs", "Disconnect", "Отключить"],
  "lessons.settings.disconnected": ["Əlaqə kəsildi", "Disconnected", "Соединение отключено"],
  "lessons.settings.connectSuccess": ["Hesab uğurla qoşuldu", "Account connected successfully", "Аккаунт успешно подключён"],
  "lessons.settings.connectFailed": ["Qoşulma alınmadı, yenidən cəhd edin", "Couldn't connect, please try again", "Не удалось подключиться, попробуйте снова"],
  "lessons.settings.connectCancelled": ["Qoşulma ləğv edildi", "Connection was cancelled", "Подключение было отменено"],
} as const;
