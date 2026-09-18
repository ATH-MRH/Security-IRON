/**
 * UI helpers : modal, notifications, formats, filtres date
 */

// ===== Internationalisation FR / AR =====
const I18N_KEY = 'securisite_lang';
const I18N_AR = {
  'SécuriSite': 'سيكوري سايت',
  'SOC // Identification Requise': 'مركز الأمن // تسجيل الدخول مطلوب',
  'Identifiant': 'اسم المستخدم',
  'Identifiant / Email': 'اسم المستخدم / البريد الإلكتروني',
  'Identifiant ou email': 'اسم المستخدم أو البريد الإلكتروني',
  'Mot de passe': 'كلمة المرور',
  'Connexion': 'دخول',
  'SOC // Centre de Sûreté': 'مركز الأمن والحراسة',
  'Pilotage': 'القيادة',
  'Tableau de bord': 'لوحة التحكم',
  'Main courante': 'السجل اليومي',
  "Journal d'incidents": 'سجل الحوادث',
  "Contrôle d'accès": 'مراقبة الدخول',
  'Accès véhicules': 'دخول المركبات',
  'Lecture plaque (LAPI)': 'قراءة اللوحات',
  'Accès piétons': 'دخول المشاة',
  'Visiteurs': 'الزوار',
  'Employés': 'الموظفون',
  'Infrastructure': 'البنية التحتية',
  'Parking': 'موقف السيارات',
  'Badges & QR': 'البطاقات ورموز QR',
  'Analyse': 'التحليل',
  'Rapports': 'التقارير',
  'Paramètres': 'الإعدادات',
  'EN DIRECT': 'مباشر',
  'Notifications': 'الإشعارات',
  'Déconnexion': 'تسجيل الخروج',
  'Administrateur': 'المدير',
  'Agent de sûreté': 'عون الأمن',
  'Présents sur site': 'الموجودون في الموقع',
  "Visiteurs aujourd'hui": 'زوار اليوم',
  'Véhicules entrés': 'المركبات الداخلة',
  'Incidents ouverts': 'الحوادث المفتوحة',
  'Actualisation temps réel': 'تحديث فوري',
  'En attente / validés': 'في الانتظار / مؤكدون',
  '24 dernières heures': 'آخر 24 ساعة',
  'À traiter': 'قيد المعالجة',
  "Flux d'accès — 7 derniers jours": 'حركة الدخول - آخر 7 أيام',
  'Répartition des accès': 'توزيع الدخول',
  'Activité récente': 'النشاط الأخير',
  'Actualiser': 'تحديث',
  'Alertes & incidents en cours': 'التنبيهات والحوادث الجارية',
  'Tout voir': 'عرض الكل',
  'Vue rapide du parking': 'نظرة سريعة على الموقف',
  'Voir le parking': 'عرض الموقف',
  'Administration système': 'إدارة النظام',
  '+ Utilisateur': '+ مستخدم',
  'Créer admin système': 'إنشاء مدير النظام',
  'Utilisateurs': 'المستخدمون',
  'Utilisateurs système': 'مستخدمو النظام',
  'Créer un utilisateur': 'إنشاء مستخدم',
  'Synthèse utilisateurs': 'ملخص المستخدمين',
  'Comptes applicatifs': 'حسابات التطبيق',
  'Administrateurs': 'المديرون',
  'Agents': 'الأعوان',
  'Total comptes': 'إجمالي الحسابات',
  'Centre de contrôle sécurité': 'مركز التحكم الأمني',
  'Votre site est sous surveillance active': 'موقعك تحت مراقبة نشطة',
  'Suivez les accès, incidents, visiteurs et mouvements en temps réel depuis un tableau de bord clair.': 'تابع الدخول والحوادث والزوار والحركات مباشرة من لوحة تحكم واضحة.',
  'Analyser maintenant': 'تحليل الآن',
  'Voir les rapports': 'عرض التقارير',
  'État système': 'حالة النظام',
  'Session': 'الجلسة',
  'Mot de passe initial': 'كلمة المرور الأولية',
  'Nom de l\'utilisateur': 'اسم المستخدم الكامل',
  'ex: agent.poste1': 'مثال: agent.poste1',
  'Badges': 'البطاقات',
  'Identifiant': 'اسم المستخدم',
  'Nom': 'الاسم',
  'Rôle': 'الدور',
  'Créé le': 'تاريخ الإنشاء',
  'Actions': 'الإجراءات',
  'Saisir une nouvelle entrée': 'إدخال تسجيل جديد',
  'Horodatage auto': 'توقيت تلقائي',
  'Poste': 'النقطة',
  'Agent en service': 'العون المناوب',
  "Type d'événement": 'نوع الحدث',
  'Priorité': 'الأولوية',
  'Lieu / Zone': 'المكان / المنطقة',
  'Date / Heure': 'التاريخ / الوقت',
  'Description': 'الوصف',
  'Enregistrer': 'حفظ',
  'Effacer': 'مسح',
  '+ Ronde RAS': '+ دورية بدون ملاحظات',
  '+ Prise service': '+ بداية الخدمة',
  'Statistiques de la journée': 'إحصائيات اليوم',
  'Agents en service': 'الأعوان المناوبون',
  'Journal en temps réel': 'السجل المباشر',
  'Tous postes': 'كل النقاط',
  'Tous types': 'كل الأنواع',
  'Toute priorité': 'كل الأولويات',
  'Rechercher...': 'بحث...',
  'Du': 'من',
  'Au': 'إلى',
  "Aujourd'hui": 'اليوم',
  'Tout': 'الكل',
  'Déclarer un incident': 'التصريح بحادث',
  'Rechercher un incident...': 'البحث عن حادث...',
  'Tous statuts': 'كل الحالات',
  'Ouvert': 'مفتوح',
  'En cours': 'قيد المعالجة',
  'Résolu': 'محلول',
  'Toute gravité': 'كل درجات الخطورة',
  'Critique': 'حرج',
  'Majeur': 'كبير',
  'Mineur': 'بسيط',
  'Critiques': 'حرجة',
  'Moyennes': 'متوسطة',
  'Faibles': 'ضعيفة',
  'Majeurs': 'كبيرة',
  'Mineurs': 'بسيطة',
  'Résolus': 'محلولة',
  'Réf.': 'المرجع',
  'Date': 'التاريخ',
  'Type': 'النوع',
  'Lieu': 'المكان',
  'Gravité': 'الخطورة',
  'Statut': 'الحالة',
  'Agent': 'العون',
  'Plaque, conducteur...': 'لوحة، سائق...',
  'Tous': 'الكل',
  'Sur site': 'داخل الموقع',
  'Sorti': 'خرج',
  'Entrée': 'دخول',
  'Sortie': 'خروج',
  'Plaque': 'اللوحة',
  'Conducteur': 'السائق',
  'Société': 'الشركة',
  'Motif': 'السبب',
  'CAMÉRA INACTIVE': 'الكاميرا غير مفعلة',
  'Activer ou importer une image': 'فعّل الكاميرا أو استورد صورة',
  'Activer': 'تفعيل',
  'Arrêter': 'إيقاف',
  'Importer': 'استيراد',
  'CAPTURER LA PLAQUE': 'التقاط اللوحة',
  'Plaque détectée': 'اللوحة المكتشفة',
  'En attente': 'في الانتظار',
  'Plaque corrigée': 'اللوحة المصححة',
  'Alerter': 'إرسال تنبيه',
  'Lectures récentes': 'القراءات الأخيرة',
  'Vider': 'تفريغ',
  'Aucune lecture': 'لا توجد قراءات',
  'Journal LAPI': 'سجل قراءة اللوحات',
  'Confiance': 'الثقة',
  'Détails': 'التفاصيل',
  'Nom, badge, point...': 'اسم، بطاقة، نقطة...',
  'Tous accès': 'كل الدخول',
  'Entrées': 'الدخول',
  'Sorties': 'الخروج',
  'Refus': 'رفض',
  'Tous points': 'كل النقاط',
  '+ Saisir un passage': '+ تسجيل مرور',
  'Entrées 24h': 'دخول 24 ساعة',
  'Sorties 24h': 'خروج 24 ساعة',
  'Refus 24h': 'رفض 24 ساعة',
  'Suspectes': 'مشبوهة',
  'Badge': 'البطاقة',
  'Point': 'النقطة',
  'Sens': 'الاتجاه',
  'Résultat': 'النتيجة',
  'Notes': 'ملاحظات',
  'Nom, hôte, société...': 'اسم، مضيف، شركة...',
  'Attendu': 'منتظر',
  '+ Préenregistrer': '+ تسجيل مسبق',
  'Visiteur': 'الزائر',
  'Hôte': 'المضيف',
  'Arrivée': 'الوصول',
  'Personnel': 'المستخدمون',
  'Accès du jour': 'دخول اليوم',
  'Nom, matricule...': 'اسم، رقم...',
  'Tous services': 'كل المصالح',
  '+ Nouvel employé': '+ موظف جديد',
  'Matricule': 'الرقم الوظيفي',
  'Service': 'المصلحة',
  'Fonction': 'الوظيفة',
  'Niveau': 'المستوى',
  'Heure': 'الوقت',
  'Total places': 'مجموع الأماكن',
  'Disponibles': 'متاحة',
  'Occupées': 'مشغولة',
  'Réservées': 'محجوزة',
  "Plan d'occupation": 'خطة الإشغال',
  'Libre': 'حر',
  'Occupé': 'مشغول',
  'Réservé': 'محجوز',
  'PMR': 'ذوي الاحتياجات',
  'Mouvements parking': 'حركات الموقف',
  'Place': 'المكان',
  'Zone': 'المنطقة',
  'Durée': 'المدة',
  'Générateur de badge': 'مولد البطاقات',
  'Nom complet': 'الاسم الكامل',
  'Validité': 'الصلاحية',
  'Niveau accès': 'مستوى الدخول',
  'Référence': 'المرجع',
  'Générer': 'إنشاء',
  'Imprimer': 'طباعة',
  'Aperçu badge & QR': 'معاينة البطاقة و QR',
  'Le QR apparaîtra ici': 'سيظهر رمز QR هنا',
  'Historique des badges': 'سجل البطاقات',
  'Émis': 'أصدر في',
  'Valide': 'صالح',
  'État': 'الحالة',
  'Période': 'الفترة',
  '7 jours': '7 أيام',
  '30 jours': '30 يوما',
  '90 jours': '90 يوما',
  'Export CSV': 'تصدير CSV',
  'Évolution des accès': 'تطور الدخول',
  'Incidents par type': 'الحوادث حسب النوع',
  "Top points d'accès": 'أهم نقاط الدخول',
  'Heures de pointe': 'ساعات الذروة',
  'Synthèse exécutive': 'ملخص تنفيذي',
  'Site': 'الموقع',
  'Nom du site': 'اسم الموقع',
  'Adresse': 'العنوان',
  'Téléphone': 'الهاتف',
  "Niveaux d'accès": 'مستويات الدخول',
  'Code': 'الرمز',
  'Libellé': 'التسمية',
  'Zones': 'المناطق',
  'Accueil': 'الاستقبال',
  'Bureaux': 'المكاتب',
  'Production': 'الإنتاج',
  'Zone sensible': 'منطقة حساسة',
  'Annuler': 'إلغاء',
  'Fermer': 'إغلاق',
  'Créer': 'إنشاء',
  'Modifier': 'تعديل',
  'Supprimer': 'حذف',
  'admin': 'مدير',
  'agent': 'عون',
  'actif': 'نشط',
  'absent': 'غائب',
  'suspendu': 'موقوف',
  'ouvert': 'مفتوح',
  'encours': 'قيد المعالجة',
  'resolu': 'محلول',
  'mineur': 'بسيط',
  'majeur': 'كبير',
  'critique': 'حرج',
  'dans': 'داخل الموقع',
  'dehors': 'خارج الموقع',
  'attendu': 'منتظر',
  'present': 'موجود',
  'parti': 'غادر',
  'autorise': 'مسموح',
  'refus': 'رفض',
  'detecte': 'مكتشف',
  'incertain': 'غير مؤكد',
  'valide': 'مؤكد',
  'refuse': 'مرفوض',
  'entree': 'دخول',
  'sortie': 'خروج',
  'Aucun incident': 'لا توجد حوادث',
  'Aucun véhicule': 'لا توجد مركبات',
  'Aucun passage': 'لا توجد عمليات مرور',
  'Aucun visiteur': 'لا يوجد زوار',
  'Aucun employé': 'لا يوجد موظفون',
  'Aucun accès': 'لا توجد عمليات دخول',
  'Aucun mouvement': 'لا توجد حركات',
  'Aucun badge': 'لا توجد بطاقات',
  'Aucun utilisateur': 'لا يوجد مستخدمون',
  'Aucune entrée trouvée': 'لم يتم العثور على تسجيلات',
  'Aucune activité récente': 'لا يوجد نشاط حديث',

  // Ajouté : restauration du support arabe pour tout le contenu introduit
  // après la dernière mise à jour de ce dictionnaire (Centre d'alertes/SOC,
  // SOS, carte, console admin, ATLAS) — jamais traduit jusqu'ici, d'où sa
  // disparition apparente au fil des fonctionnalités ajoutées.
  "SécuriSite — SOC / Centre de Sûreté": "سيكوري سايت — مركز الأمن والحراسة",
  "Command Center": "مركز القيادة",
  "Centre d’alertes": "مركز التنبيهات",
  "Carte": "الخريطة",
  "Carte & sites": "الخريطة والمواقع",
  "Véhicules": "المركبات",
  "Carte relative des sites et alertes géolocalisés": "خريطة نسبية للمواقع والتنبيهات المحددة الموقع",
  "Sites, zones et événements géolocalisés — vue relative, sans fond de carte réel.": "المواقع والمناطق والأحداث المحددة الموقع — عرض نسبي، دون خلفية خريطة حقيقية.",
  "Aucune coordonnée GPS disponible dans ce périmètre.": "لا تتوفر إحداثيات GPS في هذا النطاق.",
  "Sites du périmètre": "مواقع النطاق",
  "Activité par site": "النشاط حسب الموقع",
  "Incidents récents": "الحوادث الأخيرة",
  "Timeline opérationnelle": "الجدول الزمني التشغيلي",
  "Assistant SOC": "مساعد مركز الأمن",
  "Question à l’assistant SOC": "سؤال إلى مساعد مركز الأمن",
  "Que s’est-il passé ? Quelles alertes critiques ? Quelles escalades ?": "ماذا حدث؟ ما هي التنبيهات الحرجة؟ ما هي التصعيدات؟",
  "Demander": "اسأل",
  "Rechercher un site, un agent, un événement…": "ابحث عن موقع أو عون أو حدث…",
  "Rechercher une alerte": "البحث عن تنبيه",
  "Détail de l’alerte": "تفاصيل التنبيه",
  "Sélectionnez une alerte pour afficher sa situation et sa chronologie.": "اختر تنبيهاً لعرض وضعه وتسلسله الزمني.",
  "+ Nouvelle alerte": "+ تنبيه جديد",
  "Nouvelle alerte": "تنبيه جديد",
  "Règles & escalades": "القواعد والتصعيدات",
  "Tous les niveaux": "كل المستويات",
  "Tous les états": "كل الحالات",
  "Alerte": "تنبيه",
  "Information": "معلومة",
  "Vigilance": "يقظة",
  "SOS / Urgence": "استغاثة / طوارئ",
  "Alertes actives": "التنبيهات النشطة",
  "Critiques en cours": "الحرجة الجارية",
  "SOS en cours": "نداءات الاستغاثة الجارية",
  "Non acquittées": "غير المؤكدة",
  "Escalades en cours": "التصعيدات الجارية",
  "Alertes aujourd’hui": "تنبيهات اليوم",
  "Prise en charge moyenne": "متوسط زمن التكفل",
  "Aucune alerte active": "لا توجد تنبيهات نشطة",
  "Aucun incident récent": "لا توجد حوادث حديثة",
  "Aucune alerte pour ces filtres.": "لا توجد تنبيهات لهذه الفلاتر.",
  "Notifiée": "مُبلَّغة",
  "Acquittée": "مؤكدة",
  "En intervention": "قيد التدخل",
  "Sous contrôle": "تحت السيطرة",
  "Résolue": "محلولة",
  "Clôturée": "مغلقة",
  "Fausse alerte": "إنذار كاذب",
  "Annulée": "ملغاة",
  "Prendre en charge": "التكفل",
  "Démarrer l’intervention": "بدء التدخل",
  "Situation sous contrôle": "الوضع تحت السيطرة",
  "Résoudre": "حل",
  "Clôturer": "إغلاق",
  "Déclarant": "المصرِّح",
  "Création serveur": "إنشاء الخادم",
  "Responsable": "المسؤول",
  "Origine": "المصدر",
  "Équipement": "المعدة",
  "Position": "الموقع الجغرافي",
  "Acquittement": "التأكيد",
  "Non affectée": "غير مسندة",
  "Non renseigné": "غير محدد",
  "Non disponible": "غير متاح",
  "Escalader": "تصعيد",
  "Valider fausse alerte": "تأكيد إنذار كاذب",
  "Annuler (SOC)": "إلغاء (مركز الأمن)",
  "Demander l’annulation": "طلب الإلغاء",
  "Ajouter au journal": "إضافة إلى السجل",
  "Chronologie & audit": "التسلسل الزمني والتدقيق",
  "Résumé IA": "ملخص الذكاء الاصطناعي",
  "Généré par IA — à vérifier, jamais une décision automatique": "تم إنشاؤه بالذكاء الاصطناعي — يجب التحقق منه، وليس قراراً تلقائياً أبداً",
  "Génération du résumé…": "جارٍ إنشاء الملخص…",
  "Réflexion…": "قيد التفكير…",
  "Demande d’annulation reçue. La décision appartient au SOC ; l’historique est conservé.": "تم استلام طلب الإلغاء. القرار يعود لمركز الأمن؛ يُحفظ السجل.",
  "Documenter une action, une décision…": "توثيق إجراء أو قرار…",
  "Commentaire / motif de clôture exceptionnelle": "ملاحظة / سبب الإغلاق الاستثنائي",
  "Annulation demandée": "الإلغاء مطلوب",
  "Temps réel": "الوقت الفعلي",
  "Repli (actualisation périodique)": "احتياطي (تحديث دوري)",
  "Confirmée": "مؤكَّدة",
  "Confirmer": "تأكيد",
  "Site *": "الموقع *",
  "Type *": "النوع *",
  "Commentaire": "تعليق",
  "Intrusion, incident, anomalie…": "اقتحام، حادث، شذوذ…",
  "Créer l’alerte": "إنشاء التنبيه",
  "Les alertes de niveau 3 et 4 non acquittées sont relancées aux administrateurs. Les délais sont enregistrés avec chaque nouvelle alerte.": "يُعاد إرسال التنبيهات من المستوى 3 و4 غير المؤكدة إلى المديرين. تُسجَّل المهل مع كل تنبيه جديد.",
  "Créer une alerte pour les incidents majeurs et critiques": "إنشاء تنبيه للحوادث الكبيرة والحرجة",
  "Nombre de refus du même badge": "عدد رفض نفس البطاقة",
  "Fenêtre (secondes)": "النافذة (بالثواني)",
  "SOS — maintenir 1,5 seconde pour alerter le SOC": "SOS — اضغط مطولاً 1.5 ثانية لتنبيه مركز الأمن",
  "SOS envoyé — le SOC a été alerté": "تم إرسال نداء الاستغاثة — تم تنبيه مركز الأمن",
  "Badges actifs": "البطاقات النشطة",
  "Référentiel local": "السجل المرجعي المحلي",
  "Pointages 24h": "التسجيلات خلال 24 ساعة",
  "Incidents": "الحوادث",
  "Surveillance active": "مراقبة نشطة",
  "Système stable": "النظام مستقر",
  "Serveur": "الخادم",
  "Aucun pointage à modifier": "لا يوجد تسجيل للتعديل",
  "Utilisateur créé": "تم إنشاء المستخدم",
  "Utilisateur modifié": "تم تعديل المستخدم",
  "Pointage introuvable": "التسجيل غير موجود",
  "Autorisé": "مسموح به",
  "Refusé": "مرفوض",
  "Langue": "اللغة",
  "État de la connexion temps réel": "حالة الاتصال المباشر",
  "Nom de l'agent": "اسم العون",
  "Nom, badge ou point": "الاسم أو البطاقة أو النقطة",
  "Ex: Tourniquet, Parking A...": "مثال: بوابة دوارة، موقف أ...",
  "Décrire l'événement...": "وصف الحدث...",
  "Pivoter l'image de 90°": "تدوير الصورة 90°",
  "Effet miroir (gauche/droite)": "تأثير المرآة (يمين/يسار)",
  "Nom, matricule, site...": "الاسم أو الرقم أو الموقع...",
  "PC Sûreté": "غرفة مراقبة الأمن",
  "Poste 1": "الموقع 1",
  "Poste 2": "الموقع 2",
  "Poste 3": "الموقع 3",
  "Poste 1 — Entrée principale": "الموقع 1 — المدخل الرئيسي",
  "Poste 2 — Accueil visiteurs": "الموقع 2 — استقبال الزوار",
  "Poste 3 — Quai logistique": "الموقع 3 — رصيف اللوجستيك",
  "Rondier 1": "الجوّال 1",
  "Rondier 2": "الجوّال 2",
  "Rondier 3": "الجوّال 3",
  "Rondier 1 — Périmètre": "الجوّال 1 — المحيط",
  "Rondier 2 — Bâtiments": "الجوّال 2 — المباني",
  "Rondier 3 — Parkings": "الجوّال 3 — المواقف",
  "Chef de poste": "رئيس المناوبة",
  "Groupe A": "المجموعة أ",
  "Groupe B": "المجموعة ب",
  "Groupe C": "المجموعة ج",
  "Groupe D": "المجموعة د",
  "Tous groupes": "كل المجموعات",
  "Date affectation": "تاريخ التعيين",
  "Site affecté": "الموقع المسند",
  "N1 — Accueil": "N1 — الاستقبال",
  "N2 — Bureaux": "N2 — المكاتب",
  "N3 — Production": "N3 — الإنتاج",
  "N4 — Sensible": "N4 — حساس",
  "Validité et niveaux": "الصلاحية والمستويات",
  "Employé": "موظف",
  "Prestataire": "مقاول",
  "Temporaire": "مؤقت",
  "VISITEUR": "زائر",
  "Réf :": "المرجع:",
  "Toutes zones": "كل المناطق",
  "+ ateliers": "+ ورشات",
  "Hall, accueil": "الرَدهة، الاستقبال",
  "Hall, bureaux": "الرَدهة، المكاتب",
  "Utilitaire": "نفعية",
  "CAPTURER": "التقاط",
  "Flux caméra": "بث الكاميرا",
  "Pivoter": "تدوير",
  "Miroir": "مرآة",
  "Auto (3s)": "تلقائي (3ث)",
  "Aucune plaque": "لا توجد لوحة",
  "Non détecté": "غير مكتشف",
  "Format non reconnu": "الصيغة غير معروفة",
  "Ex: 123456-114-16": "مثال: 123456-114-16",
  "CONFIANCE OCR": "ثقة القراءة الضوئية (OCR)",
  "Livraison": "توصيل",
  "Autre": "آخر",
  "Action": "الإجراء",
  "Tourniquet Principal": "البوابة الدوارة الرئيسية",
  "Porte Nord": "البوابة الشمالية",
  "Porte Sud": "البوابة الجنوبية",
  "Sas Visiteurs": "مدخل الزوار",
  "Personnel local": "الموظفون المحليون",
  "Affectations ATLAS": "تعيينات ATLAS",
  "Direction": "الإدارة",
  "Logistique": "اللوجستيك",
  "Administration": "الإدارة العامة",
  "Sûreté": "الأمن",
  "Actif": "نشط",
  "Absent": "غائب",
  "Suspendu": "موقوف",
  "Inactif": "غير نشط",
  "SÉCURISITE 2.0 / COMMAND": "سيكوري سايت 2.0 / القيادة",
  "Comptes": "الحسابات",
  "Gérer les accès": "إدارة الدخول",
  "Historique complet": "السجل الكامل",
  "Site et sécurité": "الموقع والأمن",
  "Tout gérer": "إدارة الكل",
  "Modification des pointages": "تعديل التسجيلات",
  "Console locale": "وحدة التحكم المحلية",
  "Admin système": "مدير النظام",
  "État opérationnel": "الحالة التشغيلية",
  "Synchronisé": "متزامن",
  "Serveur local prêt": "الخادم المحلي جاهز",
  "Heure serveur": "وقت الخادم",
  "Base": "القاعدة",
  "(site non renseigné)": "(الموقع غير محدد)",
  "Ronde / Patrouille": "دورية / جولة",
  "Communication": "التواصل",
  "Anomalie": "خلل",
  "Incident": "حادث",
  "Intervention": "تدخل",
  "Contrôle": "مراقبة",
  "Relève": "المناوبة",
  "Visite": "زيارة",
  "Normale": "عادية",
  "Importante": "مهمة",
  "Maintenance": "الصيانة",
  "Tous les sites": "كل المواقع",
  "Groupe": "المجموعة",
  "Pointages": "التسجيلات",
  "Qualifier, prendre en charge et documenter chaque événement.": "تصنيف كل حدث والتكفل به وتوثيقه.",
  "📷 Module LAPI prêt. Cliquez « Activer la caméra » puis le bouton": "وحدة قراءة اللوحات جاهزة. انقر على « تفعيل الكاميرا » ثم الزر",
  "Locale": "محلية",
  "Ronde": "دورية",
  "Ouvrir le menu": "فتح القائمة",

  // UI 2.0 (modèle visuel validé) : bannière d'accueil, KPI, recherche topbar, pied de sidebar.
  "Réduire le menu": "طي القائمة",
  "IRON Global Security": "IRON Global Security",
  "Votre sécurité, notre engagement": "أمنكم، التزامنا",
  "Bonjour,": "مرحباً،",
  "Bienvenue sur SécuriSite": "مرحباً بكم في سيكوري سايت",
  "Surveillance • Réactivité • Sécurité • En temps réel": "المراقبة • سرعة الاستجابة • الأمن • في الوقت الفعلي",
  "Système opérationnel": "النظام يعمل بشكل طبيعي",
  "· tous les services sont actifs": "· جميع الخدمات نشطة",
  "Alerte immédiate": "تنبيه فوري",
  "Des sites plus sûrs": "مواقع أكثر أماناً",
  "Un monde plus serein": "عالم أكثر أماناً وهدوءاً",
  "site": "موقع",
  "sites": "مواقع",
  "Alertes critiques": "التنبيهات الحرجة",
  "Incidents en cours": "الحوادث الجارية",
  "En traitement": "قيد المعالجة",
  "8 dernières heures": "آخر 8 ساعات",
  "Site actif": "موقع نشط",
  "/ 0 site": "/ 0 موقع",
  "Rechercher un site, un agent, un événement...": "ابحث عن موقع أو عون أو حدث...",
  "Carte des sites": "خريطة المواقع",
  "Voir tous les sites": "عرض كل المواقع",
  "Flux en direct": "بث مباشر",
  "Voir toutes les caméras": "عرض كل الكاميرات",
  "Aucune caméra configurée": "لا توجد كاميرا مُعدّة",
  "Activité par heure": "النشاط حسب الساعة",
  "Répartition des alertes": "توزيع التنبيهات",
  "IA": "ذكاء اصطناعي",
  "Je peux vous aider à :": "يمكنني مساعدتك في:",
  "Analyser les alertes": "تحليل التنبيهات",
  "Rechercher un événement": "البحث عن حدث",
  "Générer un rapport": "إنشاء تقرير",
  "Vérifier l'état d'un site": "التحقق من حالة موقع",
  "Posez votre question...": "اطرح سؤالك...",
  "Envoyer": "إرسال"
};

// Many labels carry a leading/trailing icon or symbol (emoji, arrows, ✓, —)
// that isn't part of the dictionary key itself (e.g. "📊 Rapports", "Confirmée ✓").
// A pure exact-match lookup silently leaves these untranslated even though the
// underlying phrase ("Rapports", "Confirmée") IS translated — restored here by
// falling back to a symbol-stripped lookup, but only once the FULL string has
// already failed to match, so existing keys that legitimately start with a
// symbol (e.g. "+ Utilisateur") are matched exactly first and never touched.
function stripSymbols(s){
  const lead = s.match(/^[^\p{L}\p{N}]+\s*/u)?.[0] || '';
  const rest = s.slice(lead.length);
  const trail = rest.match(/\s*[^\p{L}\p{N}]+$/u)?.[0] || '';
  return { lead, core: rest.slice(0, rest.length - trail.length), trail };
}

function translateText(text, lang){
  const original = text.trim();
  if(!original) return text;
  if(I18N_AR[original]){
    if(lang === 'fr') return original;
    if(lang === 'ar') return I18N_AR[original];
    return original + ' / ' + I18N_AR[original];
  }
  const { lead, core, trail } = stripSymbols(original);
  if(core && core !== original && I18N_AR[core]){
    if(lang === 'fr') return original;
    if(lang === 'ar') return lead + I18N_AR[core] + trail;
    return original + ' / ' + lead + I18N_AR[core] + trail;
  }
  return text;
}

let i18nApplying = false;
let i18nObserverReady = false;

// Une seule langue affichée à la fois — jamais FR+AR simultanément dans la
// même interface. Le mode bilingue ('fr-ar') existait par défaut avant ce
// correctif ; le sélecteur ne l'expose plus (frontend/index.html), mais
// translateText() le gère encore si jamais explicitement demandé ailleurs.
function applyLanguage(lang = localStorage.getItem(I18N_KEY) || 'fr'){
  if(i18nApplying) return;
  // Migration silencieuse : un navigateur ayant déjà visité le site avant ce
  // correctif peut avoir 'fr-ar' persisté depuis l'ancien réglage par défaut
  // — jamais réaffiché, même pour une session déjà existante.
  if(lang === 'fr-ar') lang = 'fr';
  i18nApplying = true;
  localStorage.setItem(I18N_KEY, lang);
  document.documentElement.lang = lang === 'ar' ? 'ar' : 'fr';
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  document.querySelectorAll('.lang-select').forEach(sel=>{ sel.value = lang; });
  document.querySelectorAll('body *').forEach(el=>{
    if(['SCRIPT','STYLE','CANVAS','VIDEO'].includes(el.tagName)) return;
    [...el.childNodes].forEach(node=>{
      if(node.nodeType !== Node.TEXT_NODE) return;
      const raw = node.nodeValue;
      const trimmed = raw.trim();
      if(!trimmed) return;
      if(!node.__i18nOriginal) node.__i18nOriginal = trimmed;
      const translated = translateText(node.__i18nOriginal, lang);
      const next = raw.replace(trimmed, translated);
      if(node.nodeValue !== next) node.nodeValue = next;
    });
    ['placeholder','title','aria-label'].forEach(attr=>{
      const val = el.getAttribute?.(attr);
      if(!val) return;
      // Propriété JS directe, jamais el.dataset[...] : une clé contenant un
      // tiret ("i18nOriginalaria-label") n'est pas un nom de propriété
      // dataset valide — DOMStringMap la refuse (exception non rattrapée,
      // qui interrompait tout le reste de la boucle de traduction dès le
      // premier élément avec un aria-label, jamais détecté sans navigateur réel).
      const key = '__i18nOriginal'+attr;
      if(!el[key]) el[key] = val;
      const next = translateText(el[key], lang);
      if(el.getAttribute(attr) !== next) el.setAttribute(attr, next);
    });
  });
  i18nApplying = false;
}

function setLanguage(lang){
  applyLanguage(lang);
}

function initI18nObserver(){
  if(i18nObserverReady) return;
  i18nObserverReady = true;
  let timer = null;
  new MutationObserver(()=>{
    if(i18nApplying) return;
    clearTimeout(timer);
    timer = setTimeout(()=>applyLanguage(), 40);
  }).observe(document.body, { childList:true, subtree:true });
  applyLanguage();
}

// ===== Format =====
function fmtDateTime(iso){ if(!iso) return '—'; return new Date(iso).toLocaleString('fr-FR',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}); }
function fmtTime(iso){ if(!iso) return '—'; return new Date(iso).toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'}); }
function fmtDate(iso){ if(!iso) return '—'; return new Date(iso).toLocaleDateString('fr-FR'); }
function toDatetimeLocal(iso){ const d=new Date(iso); d.setMinutes(d.getMinutes()-d.getTimezoneOffset()); return d.toISOString().slice(0,16); }
function escapeHtml(s){ return String(s||'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function rand(arr){ return arr[Math.floor(Math.random()*arr.length)]; }
function randInt(a,b){ return Math.floor(Math.random()*(b-a+1))+a; }
// Format algérien (depuis 2009) : NNNNNN-CAA-WW — série (4 à 6 chiffres),
// catégorie de véhicule (1 chiffre) + 2 derniers chiffres de l'année
// d'immatriculation, code de wilaya (01 à 58). Jamais de lettre.
function generePlaque(){
  const serie = String(randInt(1,999999)).padStart(randInt(4,6),'0');
  const categorie = randInt(1,9);
  const annee = String(randInt(0,25)).padStart(2,'0');
  const wilaya = String(randInt(1,58)).padStart(2,'0');
  return serie+'-'+categorie+annee+'-'+wilaya;
}
function toLocalInput(d){
  const pad = n => String(n).padStart(2,'0');
  return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+'T'+pad(d.getHours())+':'+pad(d.getMinutes());
}

// ===== Modal =====
function showModal(title, body, onConfirm, btnLabel='Enregistrer'){
  const c = document.getElementById('modalContent');
  c.innerHTML = `
    <div class="modal-header">
      <div class="modal-title">${title}</div>
      <button class="modal-close" onclick="closeModal()">×</button>
    </div>
    <div class="modal-body">${body}</div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="closeModal()">Annuler</button>
      <button class="btn btn-primary" id="modalConfirm">${btnLabel}</button>
    </div>`;
  document.getElementById('modalBackdrop').classList.add('show');
  document.getElementById('modalConfirm').onclick = onConfirm;
  applyLanguage();
}
function closeModal(){ document.getElementById('modalBackdrop').classList.remove('show'); }

// ===== Notification =====
function notify(msg, type='success'){
  const colors = { success: ['var(--success)','var(--success-glow)'], warning: ['var(--warning)','var(--warning-glow)'], danger: ['var(--danger)','var(--danger-glow)'], info: ['var(--primary)','var(--primary-glow)'] };
  const [color, glow] = colors[type] || colors.success;
  const n = document.createElement('div');
  n.style.cssText = `position:fixed;bottom:24px;inset-inline-end:24px;background:var(--surface);border:1px solid ${color};color:${color};padding:12px 22px;box-shadow:0 0 20px ${glow},0 8px 24px rgba(0,0,0,0.5);z-index:2000;font-size:11px;font-family:var(--font-mono);text-transform:uppercase;letter-spacing:2px;font-weight:700;clip-path:polygon(8px 0,100% 0,100% calc(100% - 8px),calc(100% - 8px) 100%,0 100%,0 8px);transition:opacity .3s`;
  n.textContent = '◉ ' + msg;
  document.body.appendChild(n);
  setTimeout(()=>{ n.style.opacity='0'; },2700);
  setTimeout(()=>n.remove(),3000);
}

// ===== Filtres date =====
function inDateRange(iso, debId, finId){
  const deb = document.getElementById(debId)?.value;
  const fin = document.getElementById(finId)?.value;
  if(!iso) return true;
  const t = new Date(iso).getTime();
  if(deb && t < new Date(deb).getTime()) return false;
  if(fin && t > new Date(fin).getTime()) return false;
  return true;
}

function applyPreset(prefix, mode){
  const renderers = {
    inc:['incDateDeb','incDateFin',()=>renderIncidents()],
    veh:['vehDateDeb','vehDateFin',()=>renderVehicules()],
    pie:['pieDateDeb','pieDateFin',()=>renderPietons()],
    vis:['visDateDeb','visDateFin',()=>renderVisiteurs()],
    park:['parkDateDeb','parkDateFin',()=>renderParking()],
    empAcc:['empAccDateDeb','empAccDateFin',()=>renderEmpAcces()],
    mc:['mcDateDeb','mcDateFin',()=>renderMainCourante()]
  };
  const cfg = renderers[prefix]; if(!cfg) return;
  const [debId, finId, fn] = cfg;
  const debEl = document.getElementById(debId), finEl = document.getElementById(finId);
  const now = new Date(); let deb=null, fin=null;
  if(mode==='today'){ deb=new Date(now);deb.setHours(0,0,0,0); fin=new Date(now);fin.setHours(23,59,0,0); }
  else if(mode==='24h'){ deb=new Date(now.getTime()-24*3600*1000); fin=new Date(now); }
  else if(mode==='7j'){ deb=new Date(now.getTime()-7*24*3600*1000); fin=new Date(now); }
  else if(mode==='30j'){ deb=new Date(now.getTime()-30*24*3600*1000); fin=new Date(now); }
  else if(mode==='reset'){
    debEl.value=''; finEl.value='';
    const wrap = debEl.closest('.toolbar') || debEl.closest('.card-header');
    wrap?.querySelectorAll('.date-preset').forEach(b=>b.classList.remove('active'));
    fn(); return;
  }
  debEl.value = toLocalInput(deb);
  finEl.value = toLocalInput(fin);
  const wrap = debEl.closest('.toolbar') || debEl.closest('.card-header');
  wrap?.querySelectorAll('.date-preset').forEach(b=>b.classList.remove('active'));
  event?.target?.classList.add('active');
  fn();
}

// ===== Cache global pour les données =====
const cache = {
  employes: [], visiteurs: [], vehicules: [], pietons: [],
  incidents: [], badges: [], parking: { zones: [], mouvements: [] },
  mainCourante: [], lapiLectures: [], parametres: {},
  users: [], system: {}
};

async function refresh(entity){
  switch(entity){
    case 'employes': cache.employes = await API.get('/employes'); break;
    case 'visiteurs': cache.visiteurs = await API.get('/visiteurs'); break;
    case 'vehicules': cache.vehicules = await API.get('/vehicules'); break;
    case 'pietons': cache.pietons = await API.get('/pietons'); break;
    case 'incidents': cache.incidents = await API.get('/incidents'); break;
    case 'badges': cache.badges = await API.get('/badges'); break;
    case 'parking': cache.parking = await API.get('/parking'); break;
    case 'maincourante': cache.mainCourante = await API.get('/maincourante'); break;
    case 'lapi': cache.lapiLectures = await API.get('/lapi'); break;
    case 'parametres': cache.parametres = await API.get('/parametres'); break;
    case 'users': cache.users = await API.get('/admin/users'); break;
    case 'system': cache.system = await API.get('/admin/system'); break;
  }
}

// Theme global Chart.js
if(typeof Chart !== 'undefined'){
  Chart.defaults.color = '#7a8caa';
  Chart.defaults.borderColor = 'rgba(30,42,68,0.5)';
  Chart.defaults.font.family = 'Inter, sans-serif';
  Chart.defaults.font.size = 11;
}
