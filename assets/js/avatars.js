/**
 * avatars.js — the profile pictures, and the username they generate.
 *
 * Pick a face, get a name: usernames are [adjective][surname][1-20], so the
 * picture you choose is the one you are addressed by. The adjectives are drawn
 * from the same register the app is teaching, which is the joke — and they are
 * all complimentary or neutral on purpose, since these are real people and
 * "VenalColeman" is a different kind of joke than this app wants to make.
 *
 * Images are built from profile-pictures/ by tools/make-avatars.py.
 */

export const AVATARS = [
  { id: 'coleman', name: 'David Coleman',   title: 'Chief Executive Officer',                    surname: 'Coleman' },
  { id: 'singer',  name: 'Jeremy Singer',   title: 'President',                                  surname: 'Singer' },
  { id: 'packer',  name: 'Trevor Packer',   title: 'SVP, AP & Instruction',                       surname: 'Packer' },
  { id: 'olson',   name: 'Jeff Olson',      title: 'Chief Technology Officer',                   surname: 'Olson' },
  { id: 'griffin', name: 'Matthew Griffin', title: 'General Counsel',                            surname: 'Griffin' },
  { id: 'cutrona', name: 'Liza Cutrona',    title: 'Chief of Staff',                             surname: 'Cutrona' },
];

const ADJECTIVES = ('Adroit Affable Ardent Astute Candid Cogent Deft Diligent Dogged Eloquent Erudite Fervent '
  + 'Gallant Genial Intrepid Jovial Judicious Keen Lucid Magnanimous Meticulous Nimble Perspicacious Placid '
  + 'Pragmatic Prudent Resolute Resourceful Sagacious Salient Sanguine Scrupulous Stalwart Stoic Studious '
  + 'Tenacious Unflappable Urbane Valiant Vigilant Zealous').split(' ');

export const MAX_USERNAME = 32;

/** Path to an avatar image, relative to the app root. */
export const avatarSrc = (id) => `assets/avatars/${id}.jpg`;

export const findAvatar = (id) => AVATARS.find((a) => a.id === id) || null;

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

export const randomAvatarId = () => pick(AVATARS).id;

/** [adjective][surname][1-20], e.g. AstuteColeman14. */
export function randomUsername(avatarId) {
  const who = findAvatar(avatarId) || pick(AVATARS);
  const n = 1 + Math.floor(Math.random() * 20);
  return `${pick(ADJECTIVES)}${who.surname}${n}`;
}

/**
 * Fill in anything missing on first run, or after a picture is removed from the
 * set. Returns true when it changed something and the caller should save.
 */
export function ensureProfile(settings) {
  let changed = false;
  if (!findAvatar(settings.avatar)) {
    settings.avatar = randomAvatarId();
    changed = true;
  }
  if (!settings.username || !String(settings.username).trim()) {
    settings.username = randomUsername(settings.avatar);
    settings.nameCustom = false;
    changed = true;
  }
  return changed;
}
