export type StatusKey =
  | 'starting'
  | 'checking'
  | 'backingUp'
  | 'services'
  | 'welcome'
  | 'closing'
  | 'shutdownBackup'
  | 'saved';

export type StatusMessage = readonly [title: string, detail: string];
type StatusTable = Record<StatusKey, StatusMessage>;

const en: StatusTable = {
  starting: ['Starting Flo', 'Getting everything ready…'],
  checking: ['Checking your data', 'Verifying the database and keeping it healthy…'],
  backingUp: ['Backing up your data', 'Saving a safe copy before you start…'],
  services: ['Starting services', 'Almost there…'],
  welcome: ['Welcome to Flo', 'Opening your workspace…'],
  closing: ['Closing Flo', 'Saving your data. Please do not turn off the computer.'],
  shutdownBackup: ['Taking a backup', 'Please do not turn off the computer.'],
  saved: ['All saved', 'Flo will close in a moment.'],
};

const TABLES: Record<string, StatusTable> = {
  en,
  es: {
    starting: ['Iniciando Flo', 'Preparando todo…'],
    checking: ['Comprobando tus datos', 'Verificando la base de datos y manteniéndola sana…'],
    backingUp: ['Haciendo copia de seguridad', 'Guardando una copia segura antes de empezar…'],
    services: ['Iniciando servicios', 'Casi listo…'],
    welcome: ['Bienvenido a Flo', 'Abriendo tu espacio de trabajo…'],
    closing: ['Cerrando Flo', 'Guardando tus datos. No apagues el equipo.'],
    shutdownBackup: ['Haciendo copia de seguridad', 'No apagues el equipo.'],
    saved: ['Todo guardado', 'Flo se cerrará en un momento.'],
  },
  de: {
    starting: ['Flo wird gestartet', 'Alles wird vorbereitet…'],
    checking: ['Daten werden geprüft', 'Datenbank wird überprüft und in Ordnung gehalten…'],
    backingUp: ['Datensicherung läuft', 'Vor dem Start wird eine sichere Kopie gespeichert…'],
    services: ['Dienste werden gestartet', 'Gleich geschafft…'],
    welcome: ['Willkommen bei Flo', 'Ihr Arbeitsbereich wird geöffnet…'],
    closing: [
      'Flo wird beendet',
      'Ihre Daten werden gespeichert. Bitte den Computer nicht ausschalten.',
    ],
    shutdownBackup: ['Datensicherung läuft', 'Bitte den Computer nicht ausschalten.'],
    saved: ['Alles gespeichert', 'Flo schließt sich gleich.'],
  },
  tr: {
    starting: ['Flo başlatılıyor', 'Her şey hazırlanıyor…'],
    checking: ['Verileriniz kontrol ediliyor', 'Veritabanı doğrulanıyor ve sağlıklı tutuluyor…'],
    backingUp: ['Verileriniz yedekleniyor', 'Başlamadan önce güvenli bir kopya kaydediliyor…'],
    services: ['Hizmetler başlatılıyor', 'Neredeyse bitti…'],
    welcome: ["Flo'ya hoş geldiniz", 'Çalışma alanınız açılıyor…'],
    closing: ['Flo kapatılıyor', 'Verileriniz kaydediliyor. Lütfen bilgisayarı kapatmayın.'],
    shutdownBackup: ['Yedek alınıyor', 'Lütfen bilgisayarı kapatmayın.'],
    saved: ['Her şey kaydedildi', 'Flo birazdan kapanacak.'],
  },
  th: {
    starting: ['กำลังเริ่ม Flo', 'กำลังเตรียมทุกอย่าง…'],
    checking: ['กำลังตรวจสอบข้อมูลของคุณ', 'กำลังตรวจสอบฐานข้อมูลและดูแลให้อยู่ในสภาพดี…'],
    backingUp: ['กำลังสำรองข้อมูล', 'กำลังบันทึกสำเนาที่ปลอดภัยก่อนเริ่มใช้งาน…'],
    services: ['กำลังเริ่มบริการ', 'เกือบเสร็จแล้ว…'],
    welcome: ['ยินดีต้อนรับสู่ Flo', 'กำลังเปิดพื้นที่ทำงานของคุณ…'],
    closing: ['กำลังปิด Flo', 'กำลังบันทึกข้อมูลของคุณ กรุณาอย่าปิดคอมพิวเตอร์'],
    shutdownBackup: ['กำลังสำรองข้อมูล', 'กรุณาอย่าปิดคอมพิวเตอร์'],
    saved: ['บันทึกทั้งหมดแล้ว', 'Flo จะปิดในอีกสักครู่'],
  },
  fil: {
    starting: ['Sinisimulan ang Flo', 'Inihahanda ang lahat…'],
    checking: ['Sinusuri ang iyong data', 'Bine-verify ang database at pinapanatiling maayos…'],
    backingUp: ['Bina-backup ang iyong data', 'Nagse-save ng ligtas na kopya bago magsimula…'],
    services: ['Sinisimulan ang mga serbisyo', 'Malapit na…'],
    welcome: ['Maligayang pagdating sa Flo', 'Binubuksan ang iyong workspace…'],
    closing: ['Isinasara ang Flo', 'Sine-save ang iyong data. Huwag patayin ang computer.'],
    shutdownBackup: ['Gumagawa ng backup', 'Huwag patayin ang computer.'],
    saved: ['Na-save na ang lahat', 'Magsasara ang Flo sandali lang.'],
  },
  fr: {
    starting: ['Démarrage de Flo', 'Préparation de tout…'],
    checking: [
      'Vérification de vos données',
      'Contrôle de la base de données et maintien en bon état…',
    ],
    backingUp: ['Sauvegarde de vos données', 'Enregistrement d’une copie sûre avant de commencer…'],
    services: ['Démarrage des services', 'Presque terminé…'],
    welcome: ['Bienvenue dans Flo', 'Ouverture de votre espace de travail…'],
    closing: ['Fermeture de Flo', 'Enregistrement de vos données. N’éteignez pas l’ordinateur.'],
    shutdownBackup: ['Sauvegarde en cours', 'N’éteignez pas l’ordinateur.'],
    saved: ['Tout est enregistré', 'Flo va se fermer dans un instant.'],
  },
  it: {
    starting: ['Avvio di Flo', 'Preparazione di tutto…'],
    checking: ['Controllo dei tuoi dati', 'Verifica del database e mantenimento in buona salute…'],
    backingUp: ['Backup dei tuoi dati', 'Salvataggio di una copia sicura prima di iniziare…'],
    services: ['Avvio dei servizi', 'Quasi fatto…'],
    welcome: ['Benvenuto in Flo', 'Apertura del tuo spazio di lavoro…'],
    closing: ['Chiusura di Flo', 'Salvataggio dei dati. Non spegnere il computer.'],
    shutdownBackup: ['Backup in corso', 'Non spegnere il computer.'],
    saved: ['Tutto salvato', 'Flo si chiuderà tra un istante.'],
  },
  pt: {
    starting: ['Iniciando o Flo', 'Preparando tudo…'],
    checking: ['Verificando seus dados', 'Conferindo o banco de dados e mantendo-o saudável…'],
    backingUp: ['Fazendo backup dos seus dados', 'Salvando uma cópia segura antes de começar…'],
    services: ['Iniciando serviços', 'Quase lá…'],
    welcome: ['Bem-vindo ao Flo', 'Abrindo seu espaço de trabalho…'],
    closing: ['Fechando o Flo', 'Salvando seus dados. Não desligue o computador.'],
    shutdownBackup: ['Fazendo backup', 'Não desligue o computador.'],
    saved: ['Tudo salvo', 'O Flo será fechado em instantes.'],
  },
  ru: {
    starting: ['Запуск Flo', 'Подготовка…'],
    checking: ['Проверка данных', 'Проверяем базу данных и поддерживаем её в порядке…'],
    backingUp: ['Резервное копирование', 'Сохраняем надёжную копию перед началом работы…'],
    services: ['Запуск служб', 'Почти готово…'],
    welcome: ['Добро пожаловать в Flo', 'Открываем рабочее пространство…'],
    closing: ['Закрытие Flo', 'Сохраняем ваши данные. Не выключайте компьютер.'],
    shutdownBackup: ['Создание резервной копии', 'Не выключайте компьютер.'],
    saved: ['Всё сохранено', 'Flo закроется через мгновение.'],
  },
  fa: {
    starting: ['در حال راه‌اندازی Flo', 'در حال آماده‌سازی همه‌چیز…'],
    checking: ['در حال بررسی داده‌های شما', 'در حال بررسی پایگاه داده و حفظ سلامت آن…'],
    backingUp: ['در حال پشتیبان‌گیری', 'ذخیره یک نسخه امن پیش از شروع…'],
    services: ['در حال راه‌اندازی سرویس‌ها', 'تقریباً تمام شد…'],
    welcome: ['به Flo خوش آمدید', 'در حال باز کردن فضای کار شما…'],
    closing: ['در حال بستن Flo', 'در حال ذخیره داده‌های شما. لطفاً رایانه را خاموش نکنید.'],
    shutdownBackup: ['در حال پشتیبان‌گیری', 'لطفاً رایانه را خاموش نکنید.'],
    saved: ['همه‌چیز ذخیره شد', 'Flo تا لحظه‌ای دیگر بسته می‌شود.'],
  },
  ar: {
    starting: ['جارٍ تشغيل Flo', 'جارٍ تجهيز كل شيء…'],
    checking: ['جارٍ فحص بياناتك', 'جارٍ التحقق من قاعدة البيانات والحفاظ على سلامتها…'],
    backingUp: ['جارٍ النسخ الاحتياطي لبياناتك', 'جارٍ حفظ نسخة آمنة قبل البدء…'],
    services: ['جارٍ تشغيل الخدمات', 'اقتربنا من الانتهاء…'],
    welcome: ['مرحباً بك في Flo', 'جارٍ فتح مساحة عملك…'],
    closing: ['جارٍ إغلاق Flo', 'جارٍ حفظ بياناتك. يرجى عدم إيقاف تشغيل الكمبيوتر.'],
    shutdownBackup: ['جارٍ إنشاء نسخة احتياطية', 'يرجى عدم إيقاف تشغيل الكمبيوتر.'],
    saved: ['تم حفظ كل شيء', 'سيُغلق Flo بعد لحظات.'],
  },
  ur: {
    starting: ['Flo شروع ہو رہا ہے', 'سب کچھ تیار کیا جا رہا ہے…'],
    checking: ['آپ کا ڈیٹا چیک کیا جا رہا ہے', 'ڈیٹا بیس کی جانچ اور اسے درست رکھا جا رہا ہے…'],
    backingUp: [
      'آپ کے ڈیٹا کا بیک اپ لیا جا رہا ہے',
      'شروع کرنے سے پہلے محفوظ کاپی رکھی جا رہی ہے…',
    ],
    services: ['سروسز شروع ہو رہی ہیں', 'تقریباً مکمل…'],
    welcome: ['Flo میں خوش آمدید', 'آپ کا ورک اسپیس کھولا جا رہا ہے…'],
    closing: ['Flo بند ہو رہا ہے', 'آپ کا ڈیٹا محفوظ کیا جا رہا ہے۔ براہ کرم کمپیوٹر بند نہ کریں۔'],
    shutdownBackup: ['بیک اپ لیا جا رہا ہے', 'براہ کرم کمپیوٹر بند نہ کریں۔'],
    saved: ['سب کچھ محفوظ ہو گیا', 'Flo ابھی بند ہو جائے گا۔'],
  },
  ja: {
    starting: ['Flo を起動しています', 'すべて準備しています…'],
    checking: ['データを確認しています', 'データベースを検証し、正常な状態を保っています…'],
    backingUp: ['データをバックアップしています', '開始前に安全なコピーを保存しています…'],
    services: ['サービスを開始しています', 'もうすぐ完了します…'],
    welcome: ['Flo へようこそ', 'ワークスペースを開いています…'],
    closing: [
      'Flo を終了しています',
      'データを保存しています。コンピューターの電源を切らないでください。',
    ],
    shutdownBackup: ['バックアップ中', 'コンピューターの電源を切らないでください。'],
    saved: ['すべて保存しました', 'まもなく Flo を終了します。'],
  },
  zh: {
    starting: ['正在启动 Flo', '正在准备一切…'],
    checking: ['正在检查您的数据', '正在验证数据库并保持其健康…'],
    backingUp: ['正在备份您的数据', '开始前先保存一份安全副本…'],
    services: ['正在启动服务', '马上就好…'],
    welcome: ['欢迎使用 Flo', '正在打开您的工作区…'],
    closing: ['正在关闭 Flo', '正在保存您的数据。请勿关闭电脑。'],
    shutdownBackup: ['正在备份', '请勿关闭电脑。'],
    saved: ['全部已保存', 'Flo 即将关闭。'],
  },
  'zh-tw': {
    starting: ['正在啟動 Flo', '正在準備一切…'],
    checking: ['正在檢查您的資料', '正在驗證資料庫並維持其健康…'],
    backingUp: ['正在備份您的資料', '開始前先儲存一份安全副本…'],
    services: ['正在啟動服務', '即將完成…'],
    welcome: ['歡迎使用 Flo', '正在開啟您的工作區…'],
    closing: ['正在關閉 Flo', '正在儲存您的資料。請勿關閉電腦。'],
    shutdownBackup: ['正在備份', '請勿關閉電腦。'],
    saved: ['全部已儲存', 'Flo 即將關閉。'],
  },
  ko: {
    starting: ['Flo 시작 중', '모든 것을 준비하고 있습니다…'],
    checking: ['데이터 확인 중', '데이터베이스를 검증하고 정상 상태로 유지하고 있습니다…'],
    backingUp: ['데이터 백업 중', '시작하기 전에 안전한 사본을 저장하고 있습니다…'],
    services: ['서비스 시작 중', '거의 다 됐습니다…'],
    welcome: ['Flo에 오신 것을 환영합니다', '작업 공간을 여는 중…'],
    closing: ['Flo 종료 중', '데이터를 저장하고 있습니다. 컴퓨터를 끄지 마세요.'],
    shutdownBackup: ['백업 중', '컴퓨터를 끄지 마세요.'],
    saved: ['모두 저장되었습니다', '잠시 후 Flo가 종료됩니다.'],
  },
  id: {
    starting: ['Memulai Flo', 'Menyiapkan semuanya…'],
    checking: ['Memeriksa data Anda', 'Memverifikasi basis data dan menjaganya tetap sehat…'],
    backingUp: ['Mencadangkan data Anda', 'Menyimpan salinan aman sebelum Anda mulai…'],
    services: ['Memulai layanan', 'Hampir selesai…'],
    welcome: ['Selamat datang di Flo', 'Membuka ruang kerja Anda…'],
    closing: ['Menutup Flo', 'Menyimpan data Anda. Jangan matikan komputer.'],
    shutdownBackup: ['Membuat cadangan', 'Jangan matikan komputer.'],
    saved: ['Semua tersimpan', 'Flo akan segera menutup.'],
  },
  nl: {
    starting: ['Flo wordt gestart', 'Alles wordt klaargemaakt…'],
    checking: [
      'Je gegevens worden gecontroleerd',
      'De database wordt gecontroleerd en gezond gehouden…',
    ],
    backingUp: ['Back-up van je gegevens', 'Een veilige kopie wordt opgeslagen voordat je begint…'],
    services: ['Services worden gestart', 'Bijna klaar…'],
    welcome: ['Welkom bij Flo', 'Je werkruimte wordt geopend…'],
    closing: ['Flo wordt afgesloten', 'Je gegevens worden opgeslagen. Zet de computer niet uit.'],
    shutdownBackup: ['Back-up maken', 'Zet de computer niet uit.'],
    saved: ['Alles opgeslagen', 'Flo sluit zo af.'],
  },
  hi: {
    starting: ['Flo शुरू हो रहा है', 'सब कुछ तैयार किया जा रहा है…'],
    checking: ['आपका डेटा जाँचा जा रहा है', 'डेटाबेस की जाँच और उसे स्वस्थ रखा जा रहा है…'],
    backingUp: ['आपके डेटा का बैकअप लिया जा रहा है', 'शुरू करने से पहले एक सुरक्षित प्रति सहेजी जा रही है…'],
    services: ['सेवाएँ शुरू हो रही हैं', 'लगभग तैयार…'],
    welcome: ['Flo में आपका स्वागत है', 'आपका कार्यक्षेत्र खुल रहा है…'],
    closing: ['Flo बंद हो रहा है', 'आपका डेटा सहेजा जा रहा है। कृपया कंप्यूटर बंद न करें।'],
    shutdownBackup: ['बैकअप लिया जा रहा है', 'कृपया कंप्यूटर बंद न करें।'],
    saved: ['सब कुछ सहेज लिया गया', 'Flo कुछ ही क्षणों में बंद हो जाएगा।'],
  },
  bn: {
    starting: ['Flo শুরু হচ্ছে', 'সবকিছু প্রস্তুত করা হচ্ছে…'],
    checking: ['আপনার ডেটা পরীক্ষা করা হচ্ছে', 'ডেটাবেস যাচাই করে সুস্থ রাখা হচ্ছে…'],
    backingUp: ['আপনার ডেটার ব্যাকআপ নেওয়া হচ্ছে', 'শুরুর আগে একটি নিরাপদ কপি সংরক্ষণ করা হচ্ছে…'],
    services: ['সেবাগুলো চালু হচ্ছে', 'প্রায় শেষ…'],
    welcome: ['Flo-তে স্বাগতম', 'আপনার ওয়ার্কস্পেস খোলা হচ্ছে…'],
    closing: ['Flo বন্ধ হচ্ছে', 'আপনার ডেটা সংরক্ষণ করা হচ্ছে। দয়া করে কম্পিউটার বন্ধ করবেন না।'],
    shutdownBackup: ['ব্যাকআপ নেওয়া হচ্ছে', 'দয়া করে কম্পিউটার বন্ধ করবেন না।'],
    saved: ['সবকিছু সংরক্ষিত হয়েছে', 'Flo কিছুক্ষণের মধ্যে বন্ধ হবে।'],
  },
  sq: {
    starting: ['Flo po niset', 'Po përgatitet gjithçka…'],
    checking: [
      'Po kontrollohen të dhënat tuaja',
      'Po verifikohet baza e të dhënave dhe po mbahet në gjendje të mirë…',
    ],
    backingUp: ['Po bëhet kopja rezervë', 'Po ruhet një kopje e sigurt përpara se të filloni…'],
    services: ['Po nisen shërbimet', 'Pothuajse gati…'],
    welcome: ['Mirë se vini në Flo', 'Po hapet hapësira juaj e punës…'],
    closing: ['Flo po mbyllet', 'Po ruhen të dhënat tuaja. Mos e fikni kompjuterin.'],
    shutdownBackup: ['Po bëhet kopja rezervë', 'Mos e fikni kompjuterin.'],
    saved: ['Gjithçka u ruajt', 'Flo do të mbyllet pas pak.'],
  },
  vi: {
    starting: ['Đang khởi động Flo', 'Đang chuẩn bị mọi thứ…'],
    checking: [
      'Đang kiểm tra dữ liệu của bạn',
      'Đang xác minh cơ sở dữ liệu và giữ cho nó ổn định…',
    ],
    backingUp: ['Đang sao lưu dữ liệu của bạn', 'Đang lưu một bản sao an toàn trước khi bắt đầu…'],
    services: ['Đang khởi động dịch vụ', 'Sắp xong rồi…'],
    welcome: ['Chào mừng đến với Flo', 'Đang mở không gian làm việc của bạn…'],
    closing: ['Đang đóng Flo', 'Đang lưu dữ liệu của bạn. Vui lòng không tắt máy tính.'],
    shutdownBackup: ['Đang sao lưu', 'Vui lòng không tắt máy tính.'],
    saved: ['Đã lưu tất cả', 'Flo sẽ đóng trong giây lát.'],
  },
  ne: {
    starting: ['Flo सुरु हुँदैछ', 'सबै कुरा तयार गरिँदैछ…'],
    checking: ['तपाईंको डाटा जाँच गरिँदैछ', 'डाटाबेस प्रमाणित गरी स्वस्थ राखिँदैछ…'],
    backingUp: ['तपाईंको डाटाको ब्याकअप लिइँदैछ', 'सुरु गर्नु अघि सुरक्षित प्रति सुरक्षित गरिँदैछ…'],
    services: ['सेवाहरू सुरु हुँदैछन्', 'लगभग सकियो…'],
    welcome: ['Flo मा स्वागत छ', 'तपाईंको कार्यक्षेत्र खोलिँदैछ…'],
    closing: ['Flo बन्द हुँदैछ', 'तपाईंको डाटा सुरक्षित गरिँदैछ। कृपया कम्प्युटर बन्द नगर्नुहोस्।'],
    shutdownBackup: ['ब्याकअप लिइँदैछ', 'कृपया कम्प्युटर बन्द नगर्नुहोस्।'],
    saved: ['सबै सुरक्षित भयो', 'Flo केही क्षणमै बन्द हुनेछ।'],
  },
  ha: {
    starting: ['Ana fara Flo', 'Ana shirya komai…'],
    checking: ['Ana duba bayananka', "Ana tabbatar da ma'adanar bayanai tare da kiyaye lafiyarta…"],
    backingUp: ['Ana ajiyar bayananka', 'Ana adana kwafi mai aminci kafin ka fara…'],
    services: ['Ana fara ayyuka', 'An kusa kammalawa…'],
    welcome: ['Barka da zuwa Flo', 'Ana buɗe wurin aikinka…'],
    closing: ['Ana rufe Flo', 'Ana adana bayananka. Don Allah kada ka kashe kwamfutar.'],
    shutdownBackup: ['Ana yin ajiyar bayanai', 'Don Allah kada ka kashe kwamfutar.'],
    saved: ['An adana komai', 'Flo zai rufe nan take.'],
  },
  jv: {
    starting: ['Miwiti Flo', 'Nyiapake kabeh…'],
    checking: ['Mriksa data sampeyan', 'Mriksa basis data lan njaga supaya tetep sehat…'],
    backingUp: [
      'Nyadhangake data sampeyan',
      'Nyimpen salinan sing aman sadurunge sampeyan miwiti…',
    ],
    services: ['Miwiti layanan', 'Meh rampung…'],
    welcome: ['Sugeng rawuh ing Flo', 'Mbukak ruang kerja sampeyan…'],
    closing: ['Nutup Flo', 'Nyimpen data sampeyan. Aja mateni komputer.'],
    shutdownBackup: ['Nggawe cadhangan', 'Aja mateni komputer.'],
    saved: ['Kabeh wis kasimpen', 'Flo bakal enggal ditutup.'],
  },
};

export const RTL_STATUS_LANGUAGES: ReadonlySet<string> = new Set(['ar', 'fa', 'ur']);

export const STATUS_LANGUAGES: readonly string[] = Object.keys(TABLES);

/** Maps a store language or OS locale tag (en-US, zh-TW, fil-PH) to a language with messages. */
export function resolveStatusLanguage(tag: string | null | undefined): string {
  const normalized = String(tag ?? '')
    .toLowerCase()
    .replace('_', '-');
  if (TABLES[normalized]) return normalized;
  if (normalized.startsWith('zh')) {
    return /tw|hk|mo|hant/.test(normalized) ? 'zh-tw' : 'zh';
  }
  const base = normalized.split('-')[0];
  if (base === 'tl') return 'fil';
  return TABLES[base] ? base : 'en';
}

export function getStatusMessage(key: StatusKey, language: string): StatusMessage {
  return (TABLES[language] ?? en)[key];
}
