// Curated starter references from Coin Pinger's MIT-licensed preset data.
// These are physics-model estimates, not measurements or authenticity guarantees.
const SOURCE_URL = 'https://coinpinger.com/terms';

function reference(id, name, metal, peaks, tolerances, mass, diameter, thickness, image) {
  return {
    id: `reference-${id}`,
    name,
    specimenId: 'Built-in reference',
    year: metal,
    mass,
    diameter,
    thickness,
    notes: 'Built-in frequency reference for quick comparison.',
    createdAt: '2026-01-01T00:00:00.000Z',
    builtIn: true,
    referenceSource: {
      name: 'Coin Pinger preset library',
      url: SOURCE_URL,
      license: 'MIT License',
      method: 'Free circular-plate physics model using published mint specifications'
    },
    image,
    referenceProfile: {
      isReference: true,
      sampleCount: 0,
      consistency: 'Built-in',
      resonances: peaks.map((frequency, index) => ({
        frequency,
        tolerance: tolerances[index],
        support: 1,
        strength: 1,
        decay: null
      }))
    }
  };
}

export const REFERENCE_COINS = [
  reference('gold-sovereign', 'Gold Sovereign', '22 carat gold', [5315, 12275], [.072, .065], 7.988, 22.05, 1.52, {
    path: './assets/coins/gold-sovereign.webp',
    alt: 'Gold Sovereign minted in India, obverse and reverse',
    credit: 'Government of India / India Government Mint',
    license: 'CC0 1.0',
    source: 'https://commons.wikimedia.org/wiki/File:Sovereign_(minted_in_India).jpg'
  }),
  reference('gold-krugerrand-1oz', 'Gold Krugerrand 1 oz', '22 carat gold', [4630, 10630, 18435], [.071, .065, .065], 33.93, 32.77, 2.84, {
    path: './assets/coins/gold-krugerrand.webp',
    alt: '1975 one ounce Gold Krugerrand on a measurement grid',
    credit: 'Slashme',
    license: 'CC0 1.0',
    source: 'https://commons.wikimedia.org/wiki/File:Krugerrand_1975_obverse_1_oz_squared_background.jpg'
  }),
  reference('gold-american-eagle-1oz', 'Gold American Eagle 1 oz', '22 carat gold', [4670, 10720, 18585], [.071, .065, .065], 33.931, 32.7, 2.87, {
    path: './assets/coins/gold-american-eagle.webp',
    alt: 'One ounce American Gold Eagle obverse',
    credit: 'United States Mint',
    license: 'Public domain, U.S. Government work',
    source: 'https://commons.wikimedia.org/wiki/File:Liberty_$50_Obverse.png'
  }),
  reference('gold-philharmonic-1oz', 'Gold Philharmonic 1 oz', '24 carat gold', [2200, 5095, 8940], [.09, .085, .085], 31.103, 37, 2, {
    path: './assets/coins/gold-philharmonic.webp',
    alt: '2017 one ounce Vienna Gold Philharmonic obverse',
    credit: 'Wiener Philharmoniker',
    license: 'CC BY-SA 4.0',
    source: 'https://commons.wikimedia.org/wiki/File:1_oz_Vienna_Philharmonic_2017_averse.png'
  }),
  reference('silver-american-eagle-1oz', 'Silver American Eagle 1 oz', '.999 silver', [3760, 8670, 15130], [.064, .057, .057], 31.103, 40.6, 2.98, {
    path: './assets/coins/silver-american-eagle.webp',
    alt: '2022 one ounce American Silver Eagle obverse',
    credit: 'United States Mint',
    license: 'Public domain, U.S. Government work',
    source: 'https://commons.wikimedia.org/wiki/File:2022-american-eagle-silver-one-ounce-bullion-coin-obverse.png'
  }),
  reference('silver-britannia-1oz', 'Silver Britannia 1 oz', '.999 silver', [4610, 10605, 18420], [.065, .057, .057], 31.21, 38.61, 3, {
    path: './assets/coins/silver-britannia.webp',
    alt: '2021 one ounce Silver Britannia',
    credit: 'Yiyang Yao',
    license: 'CC BY-SA 4.0',
    source: 'https://commons.wikimedia.org/wiki/File:British_Britannia_Silver_2021_1Oz._.999_Fine_Silver_2_Pounds_English_coin.jpg'
  })
];
