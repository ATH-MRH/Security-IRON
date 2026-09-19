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
  'Centre de Sécurité': 'مركز الأمن',
  'Thème clair/sombre': 'الوضع الفاتح/الداكن',
  'Notifications push': 'الإشعارات الفورية',
  'Vérification…': 'جارٍ التحقق…',
  'Activer les notifications critiques': 'تفعيل التنبيهات الحرجة',
  'Non supporté par ce navigateur.': 'غير مدعوم من هذا المتصفح.',
  'Pas encore activées côté serveur.': 'لم يتم تفعيلها بعد من جهة الخادم.',
  'Bloquées par le navigateur — à réactiver dans ses réglages.': 'محظورة من طرف المتصفح — يجب إعادة تفعيلها من إعداداته.',
  'Activées sur cet appareil.': 'مفعّلة على هذا الجهاز.',
  'Recevez une notification même l’application fermée pour un SOS ou une alerte critique.': 'تلقَّ إشعاراً حتى عند إغلاق التطبيق عند نداء استغاثة أو تنبيه حرج.',
  'État indisponible pour le moment.': 'الحالة غير متوفرة حالياً.',
  'Activation…': 'جارٍ التفعيل…',
  'Notifications activées': 'تم تفعيل الإشعارات',
  'Échec de l’activation': 'فشل التفعيل',
  'Diffuser à': 'إرسال إلى',
  'Aucune diffusion (comportement habituel)': 'بدون بث (السلوك المعتاد)',
  'Un agent précis': 'عون محدد',
  'Un site': 'موقع واحد',
  'Tout le périmètre (SOC)': 'كامل النطاق (مركز الأمن)',
  'Site ciblé': 'الموقع المستهدف',
  'Agent ciblé': 'العون المستهدف',
  'Diffusion': 'البث',
  'ciblé(s)': 'مستهدف(ون)',
  'reçu(s)': 'مستلَم(ة)',
  'acquitté(s)': 'مؤكَّد(ة)',
  'reçu, en attente d’accusé': 'استُلم، بانتظار التأكيد',
  'pas encore reçu': 'لم يُستلم بعد',
  // MISSION KPI — cartes compteur (Centre d'alertes + tableau de bord)
  'vs hier': 'مقارنة بالأمس',
  'Alertes actives': 'التنبيهات النشطة',
  'Critiques en cours': 'الحرجة الجارية',
  'SOS en cours': 'نداءات الاستغاثة الجارية',
  'Non acquittées': 'غير المؤكَّدة',
  'Escalades en cours': 'التصعيدات الجارية',
  'Alertes aujourd’hui': 'تنبيهات اليوم',
  'Prise en charge moyenne': 'متوسط زمن التكفل',
  'Toutes urgences confondues': 'جميع حالات الطوارئ',
  'Niveau critique ou SOS': 'مستوى حرج أو استغاثة',
  'Alertes de détresse': 'تنبيهات استغاثة',
  'En attente de prise en charge': 'بانتظار التكفل',
  'Paliers automatiques franchis': 'مستويات تصعيد تلقائية مُجتازة',
  'Tendance sur 7 jours': 'الاتجاه خلال 7 أيام',
  'Délai moyen aujourd’hui': 'متوسط الزمن اليوم',
  // Présents sur site / Visiteurs aujourd'hui / Véhicules entrés / Incidents
  // ouverts / Actualisation temps réel / En attente / validés / 24 dernières
  // heures / À traiter : déjà enregistrées plus bas (rangée KPI historique
  // du tableau de bord) — jamais redéclarées ici, une seule clé par texte.
  'ALERTE': 'تنبيه',
  'URGENT': 'عاجل',
  'CRITIQUE': 'حرجة',
  'Émetteur': 'المُصدر',
  'SOS terrain': 'نداء استغاثة ميداني',
  'PCS01': 'PCS01',
  'Accuser réception': 'تأكيد الاستلام',
  'Voir l’alerte': 'عرض التنبيه',
  'Envoi…': 'جارٍ الإرسال…',
  'Alerte accusée — SOC notifié': 'تم تأكيد الاستلام — تم إبلاغ مركز الأمن',
  'Déjà prise en charge par un autre opérateur': 'تمت المعالجة بالفعل من قبل عون آخر',
  'L’accusé de réception est enregistré côté serveur.': 'يتم تسجيل تأكيد الاستلام على الخادم.',
  'Consultez le Centre d’alertes pour la suite du traitement.': 'يرجى مراجعة مركز التنبيهات لمتابعة المعالجة.',
  'autre alerte en attente': 'تنبيه آخر في الانتظار',
  'autres alertes en attente': 'تنبيهات أخرى في الانتظار',
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
  "Confirmation": "تأكيد",
  "Dernière synchronisation": "آخر مزامنة",
  "Généré le": "أُنشئ في",
  "Supprimer cet utilisateur ?": "هل تريد حذف هذا المستخدم؟",
  "Supprimer cette entrée ?": "هل تريد حذف هذا التسجيل؟",
  "Supprimer cet incident ?": "هل تريد حذف هذا الحادث؟",
  "Supprimer ce mouvement véhicule ?": "هل تريد حذف حركة المركبة هذه؟",
  "Vider l'historique LAPI ?": "هل تريد إفراغ سجل قراءة اللوحات؟",
  "Supprimer ce passage ?": "هل تريد حذف هذا المرور؟",
  "Supprimer ce visiteur ?": "هل تريد حذف هذا الزائر؟",
  "Supprimer cet employé ?": "هل تريد حذف هذا الموظف؟",
  "Supprimer ce badge ?": "هل تريد حذف هذه البطاقة؟",
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
  "Confiance OCR": "ثقة القراءة الضوئية (OCR)",
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

// UI-4 : applyLanguage() traduit les libellés statiques déjà dans le DOM,
// mais ne peut pas reformater une date déjà rendue (fmtDate/fmtTime/
// fmtDateTime ne sont réévalués qu'au prochain rendu). Pour que les
// dates/heures déjà affichées sur l'écran actif changent de locale sans
// recharger la page, on ré-invoque ici sa fonction de rendu — jamais sa
// fonction de chargement (pas de nouvel appel réseau, aucune donnée
// reconstruite : uniquement une repeinte depuis le cache déjà en
// mémoire, le même chemin que celui déjà déclenché par la recherche/les
// filtres sur chacun de ces écrans). Volontairement restreint aux pages
// dont le rendu est confirmé sans effet de bord (pas d'API.get) ; les
// autres (dashboard, alertes, carte…) ont déjà leur propre minuteur de
// rafraîchissement et se corrigent seules en quelques secondes.
const UI4_SAFE_RERENDER = {
  incidents: 'renderIncidents', maincourante: 'renderMainCourante',
  visiteurs: 'renderVisiteurs', vehicules: 'renderVehicules',
  pietons: 'renderPietons', employes: 'renderEmployes',
  badges: 'renderBadges', lapi: 'renderLapiTable', parking: 'renderParking',
};
function setLanguage(lang){
  applyLanguage(lang);
  const page = document.querySelector('.page.active')?.id?.replace('page-','');
  const fn = page && UI4_SAFE_RERENDER[page];
  if(fn && typeof window[fn] === 'function'){
    try{ window[fn](); }catch{ /* re-render best-effort, jamais bloquant */ }
  }
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
// UI-4 : point central unique décidant la locale date/heure — FR reste
// fr-FR, AR passe par ar-DZ (cohérent avec le contexte Algérie déjà
// présent ailleurs dans l'appli — plaques LAPI par wilaya 01-58) plutôt
// que 'ar' générique. Node/les navigateurs rendent déjà ar-DZ en
// chiffres latins (vérifié), pas de chiffres arabes-indiens à corriger.
// Toute fonction de formatage date/heure de l'appli doit passer par ici
// plutôt que réécrire son propre choix de locale.
function currentDateLocale(lang = localStorage.getItem(I18N_KEY) || 'fr'){
  return lang === 'ar' ? 'ar-DZ' : 'fr-FR';
}
function fmtDateTime(iso){ if(!iso) return '—'; return new Date(iso).toLocaleString(currentDateLocale(),{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}); }
function fmtTime(iso){ if(!iso) return '—'; return new Date(iso).toLocaleTimeString(currentDateLocale(),{hour:'2-digit',minute:'2-digit'}); }
function fmtDate(iso){ if(!iso) return '—'; return new Date(iso).toLocaleDateString(currentDateLocale()); }
// Motifs répétés ailleurs dans l'appli (jour long avec nom du jour,
// jour/mois court) — centralisés ici plutôt que dupliqués par écran.
function fmtDateLong(iso){ if(!iso) return '—'; return new Date(iso).toLocaleDateString(currentDateLocale(),{weekday:'long',day:'2-digit',month:'long',year:'numeric'}); }
function fmtDayMonth(iso){ if(!iso) return '—'; return new Date(iso).toLocaleDateString(currentDateLocale(),{day:'2-digit',month:'2-digit'}); }
function toDatetimeLocal(iso){ const d=new Date(iso); d.setMinutes(d.getMinutes()-d.getTimezoneOffset()); return d.toISOString().slice(0,16); }
function escapeHtml(s){ return String(s||'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

/**
 * MISSION KPI — mini-graphique RÉEL (jamais simulé) pour les cartes compteur
 * (Centre d'alertes + tableau de bord). `values` doit être une série déjà
 * agrégée depuis de vraies données (ex. frontend/js/soc-kpis.js#dailySeries)
 * — cette fonction ne fait que la dessiner, jamais n'en invente le contenu.
 * `var(--jeton)` fonctionne dans un attribut de présentation SVG (stroke) au
 * même titre qu'une propriété CSS dans les navigateurs ciblés par cette
 * application (déjà :has() ailleurs dans style.css) — jamais une couleur
 * codée en dur qui décrocherait du thème clair/sombre.
 */
function kpi2SparklineSvg(values, colorVar){
  if(!Array.isArray(values) || values.length<2) return null;
  const w=100, h=30, pad=3;
  const max=Math.max(...values), min=Math.min(...values), range=(max-min)||1;
  const stepX=(w-pad*2)/(values.length-1);
  const pts=values.map((v,i)=>`${(pad+i*stepX).toFixed(1)},${(h-pad-((v-min)/range)*(h-pad*2)).toFixed(1)}`).join(' ');
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="var(--${colorVar})" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

/**
 * MISSION KPI — carte compteur unique (Centre d'alertes + tableau de bord).
 * @param tone   'info'|'success'|'warning'|'danger'|'purple'|'accent' — même
 *               jeton que .kpi-card.<tone> déjà existant (couleur/icône/
 *               bandeau) et que kpi2SparklineSvg (couleur de la courbe).
 * @param trend  {direction:'up'|'down'|'flat', diff:number} pour une
 *               évolution réelle, ou null si aucune comparaison réelle
 *               n'existe pour cette carte précise (état neutre, jamais une
 *               valeur inventée). "vs hier" est isolé dans son propre span
 *               (texte fixe exact, traduisible par le même mécanisme FR/AR
 *               que le reste de l'application, frontend/js/ui.js
 *               #applyLanguage) — jamais concaténé avec le nombre, qui
 *               varie et ne peut donc jamais être une clé I18N_AR figée.
 * @param series tableau de nombres réels pour le mini-graphique, ou null/
 *               undefined si aucune série réelle n'existe pour cette carte —
 *               la géométrie de la carte reste alors identique (placeholder
 *               neutre, jamais un graphique vide qui casse la mise en page).
 */
function renderKpi2Card({icon, tone, label, value, trend, series, footerIcon, footerText}){
  const trendHtml = trend
    ? `<span class="kpi2-trend ${trend.direction}">${trend.direction==='up'?'↑':trend.direction==='down'?'↓':'→'} ${trend.diff>0?'+':''}${trend.diff} <span class="kpi2-trend-label">vs hier</span></span>`
    : `<span class="kpi2-trend neutral">—</span>`;
  const svg = series ? kpi2SparklineSvg(series, tone) : null;
  const sparkHtml = svg ? `<div class="kpi2-spark">${svg}</div>` : `<div class="kpi2-spark-empty" aria-hidden="true"></div>`;
  return `<div class="kpi-card ${tone} kpi2-card">
    <div class="kpi2-top"><div class="kpi2-icon" aria-hidden="true"><span class="kpi-icon-glyph">${icon}</span></div>${trendHtml}</div>
    <div class="kpi2-body"><div class="kpi-value">${value}</div><div class="kpi-label">${escapeHtml(label)}</div></div>
    ${sparkHtml}
    <div class="kpi2-footer"><span aria-hidden="true">${footerIcon||''}</span><span>${escapeHtml(footerText)}</span></div>
  </div>`;
}
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

// UI-3C : remplace window.confirm() (boîte de dialogue système, non
// stylable, hors Design System) par une vraie modale — même structure
// DOM que showModal(), aucun composant ajouté.
function confirmModal(message, opts={}){
  return new Promise(resolve => {
    const c = document.getElementById('modalContent');
    const danger = opts.danger !== false;
    c.innerHTML = `
      <div class="modal-header">
        <div class="modal-title">${escapeHtml(opts.title || 'Confirmation')}</div>
        <button class="modal-close" id="modalCancelX">×</button>
      </div>
      <div class="modal-body"><p style="margin:0">${escapeHtml(message)}</p></div>
      <div class="modal-footer">
        <button class="btn btn-outline" id="modalCancel">Annuler</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="modalConfirm">${escapeHtml(opts.confirmLabel || 'Confirmer')}</button>
      </div>`;
    const finish = (value) => { closeModal(); resolve(value); };
    document.getElementById('modalConfirm').onclick = () => finish(true);
    document.getElementById('modalCancel').onclick = () => finish(false);
    document.getElementById('modalCancelX').onclick = () => finish(false);
    document.getElementById('modalBackdrop').classList.add('show');
    applyLanguage();
  });
}

// ===== Notification =====
function notify(msg, type='success'){
  const n = document.createElement('div');
  n.className = 'toast ' + type;
  n.textContent = msg;
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
