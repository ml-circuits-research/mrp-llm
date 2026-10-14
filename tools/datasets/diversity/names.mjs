/** Authored names and places: a large, culturally mixed pool. No name is taken from a source dataset.
 * Given names carry a grammatical gender used for Romanian agreement (f/m); `x` means either.
 */

const pool = (culture, text) => text.trim().split(/\s*;\s*/).filter(Boolean).map(entry => {
  const [name, gender] = entry.split('/');
  return { name, gender, culture };
});

export const GIVEN_NAMES = [
  ...pool('romanian', `Ana/f; Maria/f; Ioana/f; Elena/f; Andreea/f; Mădălina/f; Ștefania/f; Irina/f; Raluca/f; Oana/f; Alina/f; Cristina/f; Bianca/f; Roxana/f; Teodora/f; Iulia/f; Diana/f; Corina/f; Smaranda/f; Ilinca/f; Brândușa/f; Otilia/f; Viorica/f; Doina/f; Floarea/f; Anca/f; Simona/f; Georgiana/f; Larisa/f; Sânziana/f; Ruxandra/f; Paula/f; Carmen/f; Mirela/f; Luminița/f; Tatiana/f; Daria/f; Medeea/f; Aurelia/f; Petronela/f;
    Andrei/m; Mihai/m; Ion/m; Ștefan/m; Bogdan/m; Răzvan/m; Radu/m; Vlad/m; Dragoș/m; Cătălin/m; Sorin/m; Florin/m; Tudor/m; Matei/m; Horia/m; Costin/m; Gheorghe/m; Nicolae/m; Vasile/m; Alexandru/m; Cosmin/m; Lucian/m; Liviu/m; Marius/m; Ovidiu/m; Petru/m; Silviu/m; Traian/m; Victor/m; Aurel/m; Emil/m; Iancu/m; Toma/m; Octavian/m; Bogdan-Ionuț/m; Ionuț/m; Viorel/m; Mircea/m; Dorin/m; Constantin/m`),
  ...pool('hungarian', `Réka/f; Enikő/f; Zsófia/f; Katalin/f; Ildikó/f; Levente/m; Csaba/m; Gábor/m; Zoltán/m; Attila/m; Botond/m; Tamás/m`),
  ...pool('english', `Emma/f; Olivia/f; Grace/f; Hannah/f; Chloe/f; Sophie/f; Megan/f; Rachel/f; Laura/f; Jessica/f; James/m; Oliver/m; Thomas/m; Daniel/m; Ethan/m; Harry/m; George/m; Samuel/m; Liam/m; Noah/m; Jack/m; Owen/m`),
  ...pool('spanish', `Lucía/f; Carmen/f; Sofía/f; Valentina/f; Paloma/f; Javier/m; Diego/m; Mateo/m; Alejandro/m; Pablo/m; Joaquín/m`),
  ...pool('french', `Camille/x; Chloé/f; Léa/f; Manon/f; Élodie/f; Hugo/m; Théo/m; Julien/m; Mathieu/m; Rémi/m`),
  ...pool('german', `Lena/f; Anna-Lena/f; Katrin/f; Jonas/m; Lukas/m; Felix/m; Moritz/m; Jürgen/m`),
  ...pool('polish', `Agnieszka/f; Małgorzata/f; Zofia/f; Wojciech/m; Paweł/m; Krzysztof/m; Łukasz/m`),
  ...pool('ukrainian', `Oksana/f; Olena/f; Nadiya/f; Taras/m; Bohdan/m; Mykola/m`),
  ...pool('greek', `Eleni/f; Dimitra/f; Nikos/m; Giorgos/m; Kostas/m`),
  ...pool('turkish', `Elif/f; Zeynep/f; Ayşe/f; Emre/m; Mehmet/m; Burak/m; Can/m`),
  ...pool('arabic', `Fatima/f; Layla/f; Amira/f; Nour/f; Omar/m; Youssef/m; Karim/m; Tariq/m; Hassan/m`),
  ...pool('persian', `Shirin/f; Parisa/f; Dariush/m; Kaveh/m`),
  ...pool('indian', `Priya/f; Ananya/f; Kavya/f; Meera/f; Arjun/m; Rohan/m; Vikram/m; Aditya/m; Rahul/m`),
  ...pool('chinese', `Mei/f; Lin/f; Xiaoling/f; Yan/f; Wei/m; Jun/m; Hao/m; Chen/m`),
  ...pool('japanese', `Yuki/x; Haruka/f; Aiko/f; Kenji/m; Takumi/m; Hiroshi/m`),
  ...pool('korean', `Ji-woo/x; Seo-yeon/f; Min-jun/m; Hyun-woo/m`),
  ...pool('vietnamese', `Linh/f; Thảo/f; Minh/m; Quang/m`),
  ...pool('nigerian', `Chioma/f; Ngozi/f; Adaeze/f; Tunde/m; Emeka/m; Chinedu/m; Oluwaseun/x`),
  ...pool('kenyan', `Wanjiru/f; Achieng/f; Kamau/m; Otieno/m`),
  ...pool('brazilian', `Beatriz/f; Larissa/f; João/m; Thiago/m; Rafael/m`),
  ...pool('scandinavian', `Ingrid/f; Astrid/f; Sigrid/f; Erik/m; Lars/m; Nils/m`),
  ...pool('roma', `Esmeralda/f; Rubina/f; Florică/m; Ghiță/m`),
  ...pool('moldovan', `Doinița/f; Natalia/f; Veaceslav/m; Iurie/m`),
];

export const SURNAMES = {
  romanian: 'Popescu Ionescu Popa Dumitrescu Stan Stoica Gheorghiu Munteanu Constantinescu Moldovan Rusu Lazăr Ciobanu Mocanu Țurcanu Bălan Oprea Diaconu Neagu Dobre Mureșan Șerban Tănase Crăciun Enache Manole Vlădescu Pătrașcu Ungureanu Florea Ardeleanu Căpraru Nistor Toma Barbu Voicu Sârbu Iordache Rădulescu Anghel'.split(' '),
  hungarian: 'Kovács Szabó Nagy Tóth Varga Farkas Balogh Fekete'.split(' '),
  english: 'Smith Taylor Brown Wilson Clarke Walker Hughes Turner Wright Bennett'.split(' '),
  spanish: 'García Martínez López Sánchez Romero Navarro'.split(' '),
  french: 'Martin Bernard Dubois Moreau Lefèvre Girard'.split(' '),
  german: 'Müller Schmidt Weber Wagner Becker Hoffmann'.split(' '),
  polish: 'Nowak Wójcik Kaczmarek Mazur Krawczyk'.split(' '),
  ukrainian: 'Shevchenko Kovalenko Bondarenko Melnyk'.split(' '),
  greek: 'Papadopoulos Georgiou Nikolaidis'.split(' '),
  turkish: 'Yılmaz Kaya Demir Şahin Çelik'.split(' '),
  arabic: 'Haddad Khalil Mansour Nasser Saleh'.split(' '),
  persian: 'Tehrani Farahani'.split(' '),
  indian: 'Sharma Patel Iyer Reddy Nair Gupta'.split(' '),
  chinese: 'Wang Li Zhang Liu Zhao'.split(' '),
  japanese: 'Sato Suzuki Tanaka Watanabe'.split(' '),
  korean: 'Kim Park Lee Choi'.split(' '),
  vietnamese: 'Nguyễn Trần Phạm'.split(' '),
  nigerian: 'Okafor Adeyemi Eze Balogun'.split(' '),
  kenyan: 'Mwangi Odhiambo Kariuki'.split(' '),
  brazilian: 'Silva Santos Oliveira Souza'.split(' '),
  scandinavian: 'Johansson Andersen Lindqvist Nilsen'.split(' '),
  roma: 'Lăutaru Stoian'.split(' '),
  moldovan: 'Cebotari Rotaru Guțu'.split(' '),
};

/** Towns and cities, weighted towards Romania and Moldova, with diacritics as written locally. */
export const PLACES = {
  romanian: 'Cluj-Napoca;Iași;Timișoara;Brașov;Sibiu;Constanța;Oradea;Suceava;Bacău;Târgu Mureș;Craiova;Galați;Ploiești;Pitești;Arad;Baia Mare;Botoșani;Focșani;Deva;Alba Iulia;Sighișoara;Bistrița;Tulcea;Reșița;Zalău;Piatra Neamț;Slatina;Călărași;Buzău;Vaslui'.split(';'),
  moldovan: ['Chișinău', 'Bălți', 'Cahul', 'Orhei'],
  world: ['Lisbon', 'Porto', 'Valencia', 'Lyon', 'Leipzig', 'Kraków', 'Lviv', 'Thessaloniki', 'Izmir', 'Alexandria', 'Pune', 'Chengdu', 'Osaka', 'Busan', 'Hanoi', 'Lagos', 'Nairobi', 'Recife', 'Bergen', 'Glasgow', 'Leeds', 'Debrecen', 'Szeged', 'Plovdiv', 'Novi Sad', 'Montreal', 'Tampere'],
};

/** Organization name builders per kind; combined with places and surnames at generation time. */
export const ORG_PATTERNS = {
  company: { en: ['{Surname} & Partners', '{Place} Logistics', 'Nordwind Systems', 'Brightfield Foods', 'Carpathia Energy', 'Delta Print', 'Orion Robotics', 'Tisa Textiles', 'Blue Harbor Media', 'Greenline Transport', 'Atelier {Surname}', 'Vertex Analytics'], ro: ['{Surname} & Asociații', '{Place} Logistic', 'Sistemele Nordwind', 'Brightfield Foods', 'Carpathia Energy', 'Tipografia Delta', 'Orion Robotics', 'Tisa Textile', 'Blue Harbor Media', 'Greenline Transport', 'Atelierul {Surname}', 'Vertex Analytics'] },
  school: { en: ['{Place} Technical College', '{Place} Arts High School', '{Place} Music Academy', 'the {Place} Language School', '{Surname} Primary School'], ro: ['Colegiul Tehnic din {Place}', 'Liceul de Arte din {Place}', 'Academia de Muzică din {Place}', 'Școala de Limbi din {Place}', 'Școala Primară {Surname}'] },
  clinic: { en: ['{Place} Children\'s Clinic', '{Place} Riverside Clinic', 'the {Place} Dental Practice', 'Saint Luke Hospital'], ro: ['Clinica de Copii din {Place}', 'Clinica Riverside din {Place}', 'Cabinetul Stomatologic din {Place}', 'Spitalul Sfântul Luca'] },
  office: { en: ['the {Place} Town Hall', 'the {Place} Tax Office', 'the Passport Office in {Place}', 'the {Place} Land Office'], ro: ['Primăria {Place}', 'Administrația Financiară {Place}', 'Serviciul de Pașapoarte {Place}', 'Oficiul de Cadastru {Place}'] },
  team: { en: ['{Place} United', 'the {Place} Wolves', 'CS {Place}', 'Rapid {Place}'], ro: ['{Place} United', 'Lupii din {Place}', 'CS {Place}', 'Rapid {Place}'] },
  venue: { en: ['the {Place} Philharmonic', 'the Old Mill Hall', 'the {Place} Arena', 'the Botanical Garden in {Place}', 'the Community Centre on Elm Street'], ro: ['Filarmonica din {Place}', 'Sala Moara Veche', 'Arena {Place}', 'Grădina Botanică din {Place}', 'Centrul Comunitar de pe strada Ulmilor'] },
};

export const cultures = [...new Set(GIVEN_NAMES.map(entry => entry.culture))];
