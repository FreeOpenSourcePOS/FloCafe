using System;
using System.Collections.Generic;
using System.Globalization;

// One Add() per FloCafe UI locale (frontend/src/lib/i18n/messages). tests/windows-uninstaller-exe.test.cjs
// fails when a locale there has no entry here.
internal static class Strings
{
    public const int Title = 0;
    public const int Warning = 1;
    public const int Done = 2;
    public const int Incomplete = 3;

    private const string Fallback = "en";
    private static readonly Dictionary<string, string[]> Table = new Dictionary<string, string[]>();

    private static void Add(string locale, string title, string warning, string done, string incomplete)
    {
        Table[locale] = new[] { title, warning, done, incomplete };
    }

    public static string[] For(string locale)
    {
        return Table[Table.ContainsKey(locale) ? locale : Fallback];
    }

    public static bool IsRtl(string locale)
    {
        return locale == "ar" || locale == "fa" || locale == "ur";
    }

    public static string Resolve(string overrideLocale, CultureInfo culture)
    {
        if (!string.IsNullOrEmpty(overrideLocale) && Table.ContainsKey(overrideLocale.ToLowerInvariant()))
            return overrideLocale.ToLowerInvariant();

        string name = culture.Name.ToLowerInvariant();
        string language = culture.TwoLetterISOLanguageName.ToLowerInvariant();
        if (language == "zh")
            return name.Contains("tw") || name.Contains("hk") || name.Contains("mo") || name.Contains("hant") ? "zh-tw" : "zh";
        if (language == "tl") return "fil";
        return Table.ContainsKey(language) ? language : Fallback;
    }

    static Strings()
    {
        Add("en", "Flo Cafe Uninstaller",
            "This will uninstall Flo Cafe and permanently delete ALL of its data from this computer: orders, menu, customers, settings, backups and the Master PIN.\n\nThis cannot be undone. To use Flo Cafe again you will have to install it from scratch.\n\nIf you may need your data, choose No now and make a backup first.\n\nDo you want to continue?",
            "Flo Cafe has been uninstalled and all of its data was deleted. To use Flo Cafe again, download and install it from scratch.",
            "Flo Cafe could not be removed completely. Close Flo Cafe fully (also check the system tray and Task Manager), then run this uninstaller again.");
        Add("ar", "برنامج إلغاء تثبيت Flo Cafe",
            "سيؤدي هذا إلى إلغاء تثبيت Flo Cafe وحذف جميع بياناته نهائيًا من هذا الكمبيوتر: الطلبات والقائمة والعملاء والإعدادات والنسخ الاحتياطية ورمز PIN الرئيسي.\n\nلا يمكن التراجع عن ذلك. لاستخدام Flo Cafe مرة أخرى سيتعين عليك تثبيته من البداية.\n\nإذا كنت قد تحتاج إلى بياناتك، اختر «لا» الآن وأنشئ نسخة احتياطية أولًا.\n\nهل تريد المتابعة؟",
            "تم إلغاء تثبيت Flo Cafe وحذف جميع بياناته. لاستخدام Flo Cafe مرة أخرى، قم بتنزيله وتثبيته من البداية.",
            "تعذر إزالة Flo Cafe بالكامل. أغلق Flo Cafe تمامًا (وتحقق أيضًا من علبة النظام ومدير المهام)، ثم شغّل برنامج إلغاء التثبيت هذا مرة أخرى.");
        Add("bn", "Flo Cafe আনইনস্টলার",
            "এটি Flo Cafe আনইনস্টল করবে এবং এই কম্পিউটার থেকে এর সমস্ত ডেটা স্থায়ীভাবে মুছে ফেলবে: অর্ডার, মেনু, গ্রাহক, সেটিংস, ব্যাকআপ এবং মাস্টার পিন।\n\nএটি পূর্বাবস্থায় ফেরানো যাবে না। আবার Flo Cafe ব্যবহার করতে হলে আপনাকে শুরু থেকে ইনস্টল করতে হবে।\n\nআপনার ডেটা দরকার হতে পারে মনে হলে এখন “না” বেছে নিন এবং আগে ব্যাকআপ নিন।\n\nআপনি কি চালিয়ে যেতে চান?",
            "Flo Cafe আনইনস্টল করা হয়েছে এবং এর সমস্ত ডেটা মুছে ফেলা হয়েছে। আবার Flo Cafe ব্যবহার করতে এটি ডাউনলোড করে শুরু থেকে ইনস্টল করুন।",
            "Flo Cafe সম্পূর্ণভাবে সরানো যায়নি। Flo Cafe সম্পূর্ণ বন্ধ করুন (সিস্টেম ট্রে ও টাস্ক ম্যানেজারও দেখুন), তারপর এই আনইনস্টলার আবার চালান।");
        Add("de", "Flo Cafe Deinstallationsprogramm",
            "Flo Cafe wird deinstalliert und ALLE Daten werden endgültig von diesem Computer gelöscht: Bestellungen, Speisekarte, Kunden, Einstellungen, Backups und die Master-PIN.\n\nDies kann nicht rückgängig gemacht werden. Um Flo Cafe erneut zu nutzen, müssen Sie es von Grund auf neu installieren.\n\nWenn Sie Ihre Daten eventuell noch brauchen, wählen Sie jetzt „Nein“ und erstellen Sie zuerst ein Backup.\n\nMöchten Sie fortfahren?",
            "Flo Cafe wurde deinstalliert und alle Daten wurden gelöscht. Um Flo Cafe erneut zu nutzen, laden Sie es herunter und installieren Sie es von Grund auf neu.",
            "Flo Cafe konnte nicht vollständig entfernt werden. Beenden Sie Flo Cafe vollständig (prüfen Sie auch den Infobereich und den Task-Manager) und führen Sie dieses Deinstallationsprogramm erneut aus.");
        Add("es", "Desinstalador de Flo Cafe",
            "Esto desinstalará Flo Cafe y eliminará permanentemente TODOS sus datos de este equipo: pedidos, menú, clientes, ajustes, copias de seguridad y el PIN maestro.\n\nEsta acción no se puede deshacer. Para volver a usar Flo Cafe tendrá que instalarlo desde cero.\n\nSi puede necesitar sus datos, elija No ahora y haga primero una copia de seguridad.\n\n¿Desea continuar?",
            "Flo Cafe se ha desinstalado y todos sus datos se han eliminado. Para volver a usar Flo Cafe, descárguelo e instálelo desde cero.",
            "No se pudo eliminar Flo Cafe por completo. Cierre Flo Cafe del todo (revise también la bandeja del sistema y el Administrador de tareas) y vuelva a ejecutar este desinstalador.");
        Add("fa", "حذف‌کننده Flo Cafe",
            "این کار Flo Cafe را حذف می‌کند و تمام داده‌های آن را برای همیشه از این رایانه پاک می‌کند: سفارش‌ها، منو، مشتریان، تنظیمات، پشتیبان‌ها و پین اصلی.\n\nاین کار قابل بازگشت نیست. برای استفاده دوباره از Flo Cafe باید آن را از ابتدا نصب کنید.\n\nاگر ممکن است به داده‌هایتان نیاز داشته باشید، اکنون «خیر» را انتخاب کنید و ابتدا پشتیبان بگیرید.\n\nآیا می‌خواهید ادامه دهید؟",
            "Flo Cafe حذف شد و تمام داده‌های آن پاک شد. برای استفاده دوباره از Flo Cafe، آن را دانلود و از ابتدا نصب کنید.",
            "Flo Cafe به‌طور کامل حذف نشد. Flo Cafe را کاملاً ببندید (سینی سیستم و Task Manager را هم بررسی کنید) و سپس این برنامه را دوباره اجرا کنید.");
        Add("fil", "Uninstaller ng Flo Cafe",
            "Aalisin nito ang Flo Cafe at permanenteng buburahin ang LAHAT ng data nito sa computer na ito: mga order, menu, customer, setting, backup, at Master PIN.\n\nHindi na ito maibabalik. Para magamit muli ang Flo Cafe, kailangan mo itong i-install mula sa simula.\n\nKung maaaring kailanganin mo ang iyong data, piliin ang Hindi ngayon at gumawa muna ng backup.\n\nGusto mo bang magpatuloy?",
            "Na-uninstall na ang Flo Cafe at nabura na ang lahat ng data nito. Para magamit muli ang Flo Cafe, i-download at i-install ito mula sa simula.",
            "Hindi ganap na naalis ang Flo Cafe. Isara nang buo ang Flo Cafe (tingnan din ang system tray at Task Manager), pagkatapos ay patakbuhin muli ang uninstaller na ito.");
        Add("fr", "Désinstallateur de Flo Cafe",
            "Cette action désinstalle Flo Cafe et supprime définitivement TOUTES ses données de cet ordinateur : commandes, menu, clients, paramètres, sauvegardes et code PIN maître.\n\nCette action est irréversible. Pour réutiliser Flo Cafe, vous devrez le réinstaller à partir de zéro.\n\nSi vous pensez avoir besoin de vos données, choisissez Non maintenant et faites d'abord une sauvegarde.\n\nVoulez-vous continuer ?",
            "Flo Cafe a été désinstallé et toutes ses données ont été supprimées. Pour réutiliser Flo Cafe, téléchargez-le et réinstallez-le à partir de zéro.",
            "Flo Cafe n'a pas pu être supprimé complètement. Fermez entièrement Flo Cafe (vérifiez aussi la zone de notification et le Gestionnaire des tâches), puis relancez ce désinstallateur.");
        Add("hi", "Flo Cafe अनइंस्टॉलर",
            "यह Flo Cafe को अनइंस्टॉल करेगा और इस कंप्यूटर से इसका सारा डेटा स्थायी रूप से हटा देगा: ऑर्डर, मेनू, ग्राहक, सेटिंग्स, बैकअप और मास्टर पिन।\n\nइसे वापस नहीं किया जा सकता। Flo Cafe को दोबारा इस्तेमाल करने के लिए आपको इसे शुरू से इंस्टॉल करना होगा।\n\nअगर आपको अपने डेटा की ज़रूरत पड़ सकती है, तो अभी “नहीं” चुनें और पहले बैकअप बना लें।\n\nक्या आप जारी रखना चाहते हैं?",
            "Flo Cafe अनइंस्टॉल हो गया है और इसका सारा डेटा हटा दिया गया है। Flo Cafe दोबारा इस्तेमाल करने के लिए इसे डाउनलोड करके शुरू से इंस्टॉल करें।",
            "Flo Cafe पूरी तरह हटाया नहीं जा सका। Flo Cafe को पूरी तरह बंद करें (सिस्टम ट्रे और टास्क मैनेजर भी देखें), फिर यह अनइंस्टॉलर दोबारा चलाएँ।");
        Add("id", "Pencopot Pemasangan Flo Cafe",
            "Tindakan ini akan mencopot Flo Cafe dan menghapus SEMUA datanya secara permanen dari komputer ini: pesanan, menu, pelanggan, pengaturan, cadangan, dan PIN Master.\n\nTindakan ini tidak dapat dibatalkan. Untuk menggunakan Flo Cafe lagi, Anda harus memasangnya dari awal.\n\nJika Anda mungkin membutuhkan data Anda, pilih Tidak sekarang dan buat cadangan terlebih dahulu.\n\nApakah Anda ingin melanjutkan?",
            "Flo Cafe telah dicopot dan semua datanya telah dihapus. Untuk menggunakan Flo Cafe lagi, unduh dan pasang dari awal.",
            "Flo Cafe tidak dapat dihapus sepenuhnya. Tutup Flo Cafe sepenuhnya (periksa juga system tray dan Task Manager), lalu jalankan pencopot pemasangan ini lagi.");
        Add("it", "Programma di disinstallazione di Flo Cafe",
            "Questa operazione disinstallerà Flo Cafe ed eliminerà in modo permanente TUTTI i suoi dati da questo computer: ordini, menu, clienti, impostazioni, backup e PIN principale.\n\nL'operazione non può essere annullata. Per usare di nuovo Flo Cafe dovrai reinstallarlo da zero.\n\nSe potresti aver bisogno dei tuoi dati, scegli No ora e crea prima un backup.\n\nVuoi continuare?",
            "Flo Cafe è stato disinstallato e tutti i suoi dati sono stati eliminati. Per usare di nuovo Flo Cafe, scaricalo e installalo da zero.",
            "Non è stato possibile rimuovere completamente Flo Cafe. Chiudi del tutto Flo Cafe (controlla anche l'area di notifica e Gestione attività), poi esegui di nuovo questo programma di disinstallazione.");
        Add("ja", "Flo Cafe アンインストーラー",
            "Flo Cafe をアンインストールし、このコンピューターからすべてのデータ（注文、メニュー、顧客、設定、バックアップ、マスターPIN）を完全に削除します。\n\nこの操作は元に戻せません。Flo Cafe を再び使うには、最初からインストールし直す必要があります。\n\nデータが必要になる可能性がある場合は、ここで「いいえ」を選び、先にバックアップを作成してください。\n\n続行しますか？",
            "Flo Cafe をアンインストールし、すべてのデータを削除しました。再び使うには、ダウンロードして最初からインストールしてください。",
            "Flo Cafe を完全に削除できませんでした。Flo Cafe を完全に終了し（システムトレイとタスクマネージャーも確認してください）、このアンインストーラーをもう一度実行してください。");
        Add("ko", "Flo Cafe 제거 프로그램",
            "Flo Cafe를 제거하고 이 컴퓨터에서 모든 데이터(주문, 메뉴, 고객, 설정, 백업, 마스터 PIN)를 영구적으로 삭제합니다.\n\n이 작업은 되돌릴 수 없습니다. Flo Cafe를 다시 사용하려면 처음부터 새로 설치해야 합니다.\n\n데이터가 필요할 수 있다면 지금 '아니요'를 선택하고 먼저 백업하세요.\n\n계속하시겠습니까?",
            "Flo Cafe가 제거되었으며 모든 데이터가 삭제되었습니다. Flo Cafe를 다시 사용하려면 다운로드하여 처음부터 설치하세요.",
            "Flo Cafe를 완전히 제거하지 못했습니다. Flo Cafe를 완전히 종료한 후(시스템 트레이와 작업 관리자도 확인하세요) 이 제거 프로그램을 다시 실행하세요.");
        Add("ne", "Flo Cafe अनइन्स्टलर",
            "यसले Flo Cafe अनइन्स्टल गर्नेछ र यो कम्प्युटरबाट यसका सबै डेटा स्थायी रूपमा मेटाउनेछ: अर्डर, मेनु, ग्राहक, सेटिङ, ब्याकअप र मास्टर पिन।\n\nयो पूर्ववत गर्न सकिँदैन। Flo Cafe फेरि प्रयोग गर्न तपाईंले यसलाई सुरुदेखि इन्स्टल गर्नुपर्नेछ।\n\nतपाईंलाई आफ्नो डेटा चाहिन सक्छ भने अहिले “होइन” छान्नुहोस् र पहिले ब्याकअप लिनुहोस्।\n\nके तपाईं जारी राख्न चाहनुहुन्छ?",
            "Flo Cafe अनइन्स्टल गरियो र यसका सबै डेटा मेटाइयो। Flo Cafe फेरि प्रयोग गर्न यसलाई डाउनलोड गरी सुरुदेखि इन्स्टल गर्नुहोस्।",
            "Flo Cafe पूर्ण रूपमा हटाउन सकिएन। Flo Cafe पूरै बन्द गर्नुहोस् (सिस्टम ट्रे र टास्क म्यानेजर पनि हेर्नुहोस्), त्यसपछि यो अनइन्स्टलर फेरि चलाउनुहोस्।");
        Add("nl", "Flo Cafe-verwijderprogramma",
            "Hiermee wordt Flo Cafe verwijderd en worden AL zijn gegevens definitief van deze computer gewist: bestellingen, menu, klanten, instellingen, back-ups en de hoofdpincode.\n\nDit kan niet ongedaan worden gemaakt. Om Flo Cafe opnieuw te gebruiken, moet u het helemaal opnieuw installeren.\n\nAls u uw gegevens misschien nog nodig hebt, kies dan nu Nee en maak eerst een back-up.\n\nWilt u doorgaan?",
            "Flo Cafe is verwijderd en alle gegevens zijn gewist. Om Flo Cafe opnieuw te gebruiken, downloadt u het en installeert u het helemaal opnieuw.",
            "Flo Cafe kon niet volledig worden verwijderd. Sluit Flo Cafe volledig af (controleer ook het systeemvak en Taakbeheer) en voer dit verwijderprogramma opnieuw uit.");
        Add("pt", "Desinstalador do Flo Cafe",
            "Isto irá desinstalar o Flo Cafe e apagar permanentemente TODOS os seus dados deste computador: pedidos, menu, clientes, configurações, backups e o PIN mestre.\n\nEsta ação não pode ser desfeita. Para voltar a usar o Flo Cafe, terá de o instalar do zero.\n\nSe puder precisar dos seus dados, escolha Não agora e faça primeiro um backup.\n\nDeseja continuar?",
            "O Flo Cafe foi desinstalado e todos os seus dados foram apagados. Para voltar a usar o Flo Cafe, transfira-o e instale-o do zero.",
            "Não foi possível remover o Flo Cafe por completo. Feche totalmente o Flo Cafe (verifique também a bandeja do sistema e o Gerenciador de Tarefas) e execute este desinstalador novamente.");
        Add("ru", "Программа удаления Flo Cafe",
            "Flo Cafe будет удалён, а ВСЕ его данные будут безвозвратно стёрты с этого компьютера: заказы, меню, клиенты, настройки, резервные копии и мастер-PIN.\n\nЭто действие нельзя отменить. Чтобы снова пользоваться Flo Cafe, его придётся установить заново.\n\nЕсли данные могут вам понадобиться, выберите «Нет» и сначала сделайте резервную копию.\n\nПродолжить?",
            "Flo Cafe удалён, все его данные стёрты. Чтобы снова пользоваться Flo Cafe, скачайте и установите его заново.",
            "Не удалось полностью удалить Flo Cafe. Полностью закройте Flo Cafe (проверьте также системный трей и Диспетчер задач) и запустите эту программу удаления ещё раз.");
        Add("sq", "Çinstaluesi i Flo Cafe",
            "Kjo do të çinstalojë Flo Cafe dhe do të fshijë përgjithmonë TË GJITHA të dhënat e tij nga ky kompjuter: porositë, menunë, klientët, cilësimet, kopjet rezervë dhe PIN-in kryesor.\n\nKjo nuk mund të zhbëhet. Për ta përdorur sërish Flo Cafe, do ta instaloni nga e para.\n\nNëse mund t'ju duhen të dhënat, zgjidhni Jo tani dhe bëni fillimisht një kopje rezervë.\n\nDoni të vazhdoni?",
            "Flo Cafe u çinstalua dhe të gjitha të dhënat e tij u fshinë. Për ta përdorur sërish Flo Cafe, shkarkojeni dhe instalojeni nga e para.",
            "Flo Cafe nuk u hoq plotësisht. Mbylleni plotësisht Flo Cafe (kontrolloni edhe tabakanë e sistemit dhe Task Manager), pastaj ekzekutoni sërish këtë çinstalues.");
        Add("th", "ตัวถอนการติดตั้ง Flo Cafe",
            "การดำเนินการนี้จะถอนการติดตั้ง Flo Cafe และลบข้อมูลทั้งหมดออกจากคอมพิวเตอร์เครื่องนี้อย่างถาวร ได้แก่ ออเดอร์ เมนู ลูกค้า การตั้งค่า ข้อมูลสำรอง และ PIN หลัก\n\nไม่สามารถย้อนกลับได้ หากต้องการใช้ Flo Cafe อีกครั้ง คุณต้องติดตั้งใหม่ตั้งแต่ต้น\n\nหากคุณอาจต้องใช้ข้อมูลนี้ ให้เลือก “ไม่” ตอนนี้ แล้วสำรองข้อมูลก่อน\n\nต้องการดำเนินการต่อหรือไม่?",
            "ถอนการติดตั้ง Flo Cafe และลบข้อมูลทั้งหมดเรียบร้อยแล้ว หากต้องการใช้ Flo Cafe อีกครั้ง ให้ดาวน์โหลดและติดตั้งใหม่ตั้งแต่ต้น",
            "ไม่สามารถลบ Flo Cafe ได้อย่างสมบูรณ์ โปรดปิด Flo Cafe ให้หมด (ตรวจสอบถาดระบบและ Task Manager ด้วย) แล้วเรียกใช้ตัวถอนการติดตั้งนี้อีกครั้ง");
        Add("tr", "Flo Cafe Kaldırıcı",
            "Bu işlem Flo Cafe'yi kaldıracak ve bu bilgisayardaki TÜM verilerini kalıcı olarak silecektir: siparişler, menü, müşteriler, ayarlar, yedekler ve Ana PIN.\n\nBu işlem geri alınamaz. Flo Cafe'yi yeniden kullanmak için sıfırdan kurmanız gerekecek.\n\nVerilerinize ihtiyaç duyabilirseniz şimdi Hayır'ı seçin ve önce yedek alın.\n\nDevam etmek istiyor musunuz?",
            "Flo Cafe kaldırıldı ve tüm verileri silindi. Flo Cafe'yi yeniden kullanmak için indirip sıfırdan kurun.",
            "Flo Cafe tamamen kaldırılamadı. Flo Cafe'yi tümüyle kapatın (sistem tepsisini ve Görev Yöneticisi'ni de kontrol edin), ardından bu kaldırıcıyı yeniden çalıştırın.");
        Add("ur", "Flo Cafe ان انسٹالر",
            "یہ Flo Cafe کو ان انسٹال کر دے گا اور اس کمپیوٹر سے اس کا تمام ڈیٹا ہمیشہ کے لیے حذف کر دے گا: آرڈرز، مینیو، کسٹمرز، سیٹنگز، بیک اپ اور ماسٹر پن۔\n\nاسے واپس نہیں کیا جا سکتا۔ Flo Cafe دوبارہ استعمال کرنے کے لیے آپ کو اسے شروع سے انسٹال کرنا ہوگا۔\n\nاگر آپ کو اپنے ڈیٹا کی ضرورت پڑ سکتی ہے تو ابھی «نہیں» منتخب کریں اور پہلے بیک اپ بنا لیں۔\n\nکیا آپ جاری رکھنا چاہتے ہیں؟",
            "Flo Cafe ان انسٹال ہو گیا ہے اور اس کا تمام ڈیٹا حذف کر دیا گیا ہے۔ Flo Cafe دوبارہ استعمال کرنے کے لیے اسے ڈاؤن لوڈ کر کے شروع سے انسٹال کریں۔",
            "Flo Cafe مکمل طور پر ہٹایا نہیں جا سکا۔ Flo Cafe کو مکمل طور پر بند کریں (سسٹم ٹرے اور ٹاسک مینیجر بھی دیکھیں)، پھر یہ ان انسٹالر دوبارہ چلائیں۔");
        Add("vi", "Trình gỡ cài đặt Flo Cafe",
            "Thao tác này sẽ gỡ cài đặt Flo Cafe và xóa vĩnh viễn TOÀN BỘ dữ liệu của ứng dụng khỏi máy tính này: đơn hàng, thực đơn, khách hàng, cài đặt, bản sao lưu và mã PIN chính.\n\nKhông thể hoàn tác. Để dùng lại Flo Cafe, bạn sẽ phải cài đặt lại từ đầu.\n\nNếu bạn có thể cần dữ liệu, hãy chọn Không ngay bây giờ và sao lưu trước.\n\nBạn có muốn tiếp tục không?",
            "Flo Cafe đã được gỡ cài đặt và toàn bộ dữ liệu đã bị xóa. Để dùng lại Flo Cafe, hãy tải xuống và cài đặt lại từ đầu.",
            "Không thể gỡ Flo Cafe hoàn toàn. Hãy đóng hẳn Flo Cafe (kiểm tra cả khay hệ thống và Task Manager), rồi chạy lại trình gỡ cài đặt này.");
        Add("zh", "Flo Cafe 卸载程序",
            "此操作将卸载 Flo Cafe，并从这台电脑上永久删除它的所有数据：订单、菜单、顾客、设置、备份和主 PIN。\n\n此操作无法撤销。若要再次使用 Flo Cafe，您需要从头重新安装。\n\n如果您可能还需要这些数据，请现在选择“否”，并先进行备份。\n\n是否继续？",
            "Flo Cafe 已卸载，其所有数据已被删除。若要再次使用 Flo Cafe，请下载并从头重新安装。",
            "无法完全移除 Flo Cafe。请彻底关闭 Flo Cafe（同时检查系统托盘和任务管理器），然后再次运行此卸载程序。");
        Add("zh-tw", "Flo Cafe 解除安裝程式",
            "此操作將解除安裝 Flo Cafe，並從這台電腦永久刪除其所有資料：訂單、菜單、顧客、設定、備份和主 PIN。\n\n此操作無法復原。若要再次使用 Flo Cafe，您必須從頭重新安裝。\n\n如果您可能還需要這些資料，請現在選擇「否」，並先進行備份。\n\n是否繼續？",
            "Flo Cafe 已解除安裝，其所有資料已被刪除。若要再次使用 Flo Cafe，請下載並從頭重新安裝。",
            "無法完全移除 Flo Cafe。請徹底關閉 Flo Cafe（同時檢查系統匣和工作管理員），然後再次執行此解除安裝程式。");
    }
}
