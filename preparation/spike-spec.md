# Spike spec (pre-hackathon)

> Copie de `note.md` (tribal_authentica). Le fichier d'origine a été réécrit le 9 nov. 2026 ;
> la section 1 est la spec initiale (reconstituée telle quelle), la section 2 est l'addendum du 9 nov.

## 1. Spec initiale

Contexte : je prépare le hackathon BCH BLAZE 2026 (Bitcoin Cash, DoraHacks). Le hacking officiel commence le 14 nov 2026 à 14:00 UTC ; seul le travail fait après cette date est noté. Cette semaine je fais UNIQUEMENT des spikes jetables pour apprendre l'outillage et dérisquer le contrat principal. Je suis sur Windows (PowerShell).

ÉTAPE 0 — Inventaire, sans rien modifier
- Le dossier courant (tribal_authentica) est un ancien repo. Liste son contenu, montre git status / git log --oneline -10 et résume le README. NE MODIFIE RIEN dedans.
- Vérifie node -v (>= 20), npm -v, git. Dis-moi s'il manque quelque chose.

ÉTAPE 1 — Nouveau dossier de préparation, à côté (pas dedans)
Crée C:\Users\thoma\Bureau\ta-blaze-prep avec :
- preparation/  → docs qui iront dans le repo final (README.md expliquant que ce sont les plans d'avant hackathon, decisions.md, contract-spec.md)
- spikes/       → code jetable, clairement marqué "PRE-HACKATHON SPIKE — NOT PART OF THE SUBMISSION"
- .gitignore (node_modules, .env, *.key), git init.

ÉTAPE 2 — Spike "Royalty Vault" en CashScript, CHIPNET UNIQUEMENT
Utilise la dernière version de cashscript + cashc (vérifie la doc sur cashscript.org pour la syntaxe tokens/introspection actuelle) et ElectrumNetworkProvider('chipnet'). Pour créer des wallets et minter le token, utilise mainnet-js ou @bitauth/libauth, comme tu le juges le plus simple. Clés en .env, jamais committées. Faucet chipnet : tbch.googol.cash.

Spécification du contrat RoyaltyVault :
- Un NFT CashTokens MUTABLE par masque, qui vit toujours à l'adresse du contrat.
- Commitment = ownerPkh (20 octets) || price (8 octets, little-endian ; 0 = pas en vente).
- Paramètres du contrat : artisanLockingBytecode, royaltyBps (ex. 1000 = 10 %), minRoyaltySats (plancher anti "vente à 1 sat entre complices").
- Fonction list(pubkey ownerPk, sig ownerSig, int newPrice) :
  hash160(ownerPk) == ownerPkh du commitment ; checkSig ; output[0] = même contrat (this.activeBytecode), même tokenCategory, commitment = ownerPkh || newPrice.
- Fonction buy(bytes20 buyerPkh) :
  price > 0 ; output[0] = NFT de retour dans le contrat, même catégorie, commitment = buyerPkh || 0 ;
  output[1] = P2PKH(ownerPkh) qui reçoit >= price - royalty ;
  output[2] = artisanLockingBytecode qui reçoit >= max(price * royaltyBps / 10000, minRoyaltySats).
- Vérifie toujours la catégorie via tx.inputs[this.activeInputIndex].tokenCategory, et que le NFT ne peut jamais sortir du contrat.

Script de démo (spikes/vault/demo.ts) qui, sur chipnet :
1. crée 3 wallets (artisan, owner1, buyer) et affiche les adresses à financer via le faucet ;
2. mint 1 NFT mutable et l'envoie au contrat avec owner1 comme propriétaire ;
3. owner1 met en vente à X sats ;
4. buyer achète → affiche les txids + liens explorer chipnet (chipnet.bch.ninja) et les soldes artisan / owner1 / buyer ;
5. TESTS DE CONTOURNEMENT qui DOIVENT échouer : acheter sans payer l'artisan, sortir le NFT du contrat, list() signé par quelqu'un d'autre que le propriétaire, royalty sous le plancher. Affiche clairement PASS/FAIL pour chacun.

ÉTAPE 3 — Seulement si l'étape 2 passe : spike "Patron Dispenser"
Contrat qui détient un stock de tokens FUNGIBLES "Patron". claim() : output[0] = le reste du stock (tokenAmount - 1) qui revient au contrat ; output[1] = l'artisan reçoit >= patronPriceSats ; output[2] = 1 token vers n'importe quelle adresse. Démo avec le stock réparti sur 5 UTXOs, et 2 claims en parallèle pour vérifier qu'ils ne se bloquent pas.

ÉTAPE 4 — Rapport dans preparation/spike-report.md
Ce qui marche, ce qui a coincé, versions des libs, limites découvertes (taille du commitment, frais, problèmes de concurrence), et ce que je dois réécrire proprement à partir du 14.

Règles : chipnet seulement, aucun fonds mainnet. Avance étape par étape et montre-moi le résultat de chaque étape avant de passer à la suivante. Si une hypothèse de la spec est impossible en CashScript, dis-le et propose l'alternative la plus proche au lieu de la contourner en silence.

## 2. Addendum du 9 nov. 2026

Décision : on suit le modèle de note.md (NFT mutable qui vit TOUJOURS dans le contrat, propriétaire et prix dans le commitment, artisan en paramètre du contrat). Le modèle du README est abandonné : il laisse le propriétaire transférer le NFT hors contrat et contourner la royalty.

Ajouts à la spec :
1. Première vente = 100 % à l'artisan, sans signature de l'artisan : au mint, le commitment est directement ownerPkh = hash160 de la pubkey de l'artisan, price = prix de première vente. Le masque est donc en vente dès le mint. Lors du buy(), le vendeur (l'artisan) et la royalty (l'artisan) sont deux outputs vers la même adresse : vérifie que ça passe, ou propose une variante propre (ex. si ownerPkh correspond à l'artisan, un seul output >= price).
2. Ajoute ce cas au script de démo : mint "déjà en vente" → buyer1 achète (artisan reçoit tout) → buyer1 remet en vente → buyer2 achète (buyer1 payé, artisan touche la royalty).
3. Ajoute un test de contournement : buyer1 tente de transférer le NFT à buyer2 sans buy() → doit échouer.

Avant l'étape 1 : copie README.txt (version modifiée) et note.md dans ta-blaze-prep/preparation/ sous les noms readme-v1-old-model.md et spike-spec.md. Ne commite rien dans tribal_authentica et ne touche pas aux dossiers contracts/backend/frontend : ce repo ne sera pas réutilisé, le repo final sera créé neuf le 14 novembre.
