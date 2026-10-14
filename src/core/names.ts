import { pick, type Rng } from "./rng.js";

const list = (s: string): string[] => s.split(",").map((n) => n.trim()).filter(Boolean);

export const THEMES: Record<string, { planets: string[]; moons: string[]; ships: string[] }> = {
  classic: {
    planets: list("Hyperion, Thalassa, Kepler, Aegir, Atlas, Helios, Selene, Eos, Gaia, Nyx, Erebus, Chronos, Rhea, Tethys, Oceanus, Themis, Prometheus, Epimetheus, Phoebe, Leto, Hestia, Demeter, Persephone, Hephaestus, Artemis, Apollo, Athena, Hermes, Poseidon, Triton, Perseus, Orion, Andromeda, Cassiopeia, Pegasus, Ariadne, Calypso, Circe, Hesperus, Boreas"),
    moons: list("Io, Nix, Puck, Larissa, Europa, Ganymede, Callisto, Amalthea, Thebe, Metis, Adrastea, Himalia, Elara, Pasiphae, Sinope, Lysithea, Carme, Ananke, Leda, Titan, Enceladus, Mimas, Dione, Iapetus, Janus, Pandora, Prometheus, Atlas, Pan, Daphnis, Ariel, Umbriel, Oberon, Titania, Miranda, Cordelia, Ophelia, Bianca, Cressida, Desdemona, Juliet, Portia, Rosalind, Belinda, Perdita, Mab, Cupid, Nereid, Naiad, Thalassa, Despina, Galatea, Proteus, Charon, Hydra, Kerberos, Styx, Dysnomia, Hiiaka, Namaka"),
    ships: list("Dawn Treader, Meridian, Long Patience, Unfurled Sail, Steadfast, Far Harbor, Northern Reach, Quiet Provision, Faithful Courier, Mercy of Distance, Lantern Bearer, Evening Tide, Grey Horizon, Patient Anchor, Tall Resolve, Second Wind, Pale Meridian, Distant Hearth, Steward of Light, Constant Heading, Bright Passage, Open Water, Iron Promise, Sure Landfall, Last Lighthouse, Kindly Keel, Slow Thunder, Winter Crossing, Silver Ledger, Honest Cargo, Wayfarer, Pilgrim, Sojourner, Endeavour, Resolute, Discovery, Intrepid, Perseverance, Fortitude, Temperance, Prudence, Providence, Concord, Accord, Harmony, Vigilant, Sentinel, Bulwark, Beacon, Compass Rose, Polestar, Landmark, Waypoint, Cairn, Anchorage, Haven Bound, Hearth Keeper, Trade Wind, Morning Star, Gentle Ballast"),
  },
  pulp: {
    planets: list("Arrakis, Gallifrey, Magrathea, Tatooine, Vulcan, Krypton, Solaris, Pandora, Endor, Hoth, Naboo, Dagobah, Kamino, Alderaan, Caprica, Trantor, Terminus, Ceti Alpha, Skaro, Vogsphere, Betelgeuse, Cybertron, Coruscant, Mustafar, Bespin, Genesis, Altair, Omicron Persei, Risa, Qo'noS, Romulus, Ferenginar, Barrayar, Gethen, Hyperion Prime, Lusitania, Riverworld, Discworld, Pern, Dune Minor"),
    moons: list("Yavin, Endor Moon, Death Star, Luna Prime, Bajor, Deep Space, Mongo, Miranda, Tralfamadore, Santa Maria, Nibiru, Sakaar, Titan Base, Moonbase Alpha, Gamma Station, Outpost Nine, Ringworld, Halo, Rama, Hyperion Moon, Acheron, Zeta Station, Fort Nowhere, Ice Hotel, Cloud City, Mos Eisley, Mos Espa, Jedha, Scarif, Crait, Ahch-To, Dantooine, Kessel, Ryloth, Geonosis, Utapau, Felucia, Mygeeto, Kashyyyk, Zanarkand, Gaia Beacon, Eden Prime, Ilos, Omega, Citadel, Tuchanka, Palaven, Thessia, Rannoch, Noveria, Feros, Therum, Virmire, Ord Mantell, Telos, Nar Shaddaa, Taris, Manaan, Korriban, Tython"),
    ships: list("Heart of Gold, Rocinante, Serenity, Nostromo, Bebop, Normandy, Event Horizon, Red Dwarf, Millennium Falcon, Enterprise, Galactica, Planet Express, Liberator, Tardis Mk II, Discovery One, Sulaco, Prometheus, Axiom, Thunderbird, Moya, Andromeda Ascendant, Icarus, Covenant, Pillar of Autumn, Infinity, Bounty, Ghost, Razor Crest, Slave One, Outrider, Eagle Five, Starbug, Nebuchadnezzar, Jupiter 2, Orville, Valley Forge, Cygnus, Hermes, Endurance, Ranger, Lander, Sunshine, Zero Gravity, Vengeance, Defiant, Voyager, Excelsior, Reliant, Bellerophon, Lexington, Yamato, Tantive IV, Executor, Home One, Swordfish II, Yellow Submarine, Spaceball One, Eagle Transporter, Dark Star, Kestrel"),
  },
};

export function pickName(rng: Rng, pool: readonly string[], used: Set<string>): string {
  const free = pool.filter((n) => !used.has(n));
  let name = free.length ? pick(rng, free) : pick(rng, pool);
  const ROMAN = ["", "-II", "-III", "-IV", "-V", "-VI", "-VII", "-VIII", "-IX", "-X"];
  for (let i = 1; used.has(name) && i < ROMAN.length; i++) name = `${name.replace(/-[IVX]+$/, "")}${ROMAN[i]}`;
  while (used.has(name)) name = `${name}-${Math.floor(rng() * 1e6)}`;
  used.add(name);
  return name;
}
