// 駅伝タイム計測 v0.2
// Firebaseを未設定のままでも、1台の端末でローカル試作できます。
// 複数端末で同期する場合は Firebase Console で Webアプリを作成し、
// 下の null を、ご自身の firebaseConfig に置き換えてください。
//
// 例：
// window.EKIDEN_FIREBASE_CONFIG = {
//   apiKey: "...",
//   authDomain: "...firebaseapp.com",
//   databaseURL: "https://...-default-rtdb.asia-southeast1.firebasedatabase.app",
//   projectId: "...",
//   storageBucket: "...appspot.com",
//   messagingSenderId: "...",
//   appId: "..."
// };
window.EKIDEN_FIREBASE_CONFIG = null;

// Realtime Database 内で使用する保存先。バスアプリと同じFirebaseを使う場合も
// このパスを分けておけばデータが混ざりません。
window.EKIDEN_APP_OPTIONS = {
  rootPath: "ekidenTimerV02"
};
