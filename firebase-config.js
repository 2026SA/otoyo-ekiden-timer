// 大豊学園 駅伝大会運営システム v0.3
// Firebase Realtime Database + Anonymous Authentication
window.EKIDEN_FIREBASE_CONFIG = {
  apiKey: "AIzaSyBD1RRYN6T6aJaRRNeRZX4KhPJePIH7DNw",
  authDomain: "otoyo-ekiden-timer.firebaseapp.com",
  databaseURL: "https://otoyo-ekiden-timer-default-rtdb.asia-southeast1.firebasedatabase.app/",
  projectId: "otoyo-ekiden-timer",
  storageBucket: "otoyo-ekiden-timer.firebasestorage.app",
  messagingSenderId: "904817111477",
  appId: "1:904817111477:web:b64b240e1967e6fc0769fc"
};

// v0.2と同じ保存先を使い、既存の計測データを継続利用します。
window.EKIDEN_APP_OPTIONS = {
  rootPath: "ekidenTimerV02"
};
