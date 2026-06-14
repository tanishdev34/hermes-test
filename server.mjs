import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, 'dist');
const PORT = process.env.PORT || 3200;

// API-Football configuration
const API_KEY = process.env.API_FOOTBALL_KEY || '';
const API_BASE = 'https://v3.football.api-sports.io';
const WC_LEAGUE = 1;
const WC_SEASON = 2026;

// Simple in-memory cache (resets on restart)
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCached(key) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.data;
  return null;
}

function setCache(key, data) {
  cache.set(key, { data, ts: Date.now() });
}

async function apiFetch(endpoint) {
  if (!API_KEY) return null;
  const cached = getCached(endpoint);
  if (cached) return cached;

  try {
    const res = await fetch(`${API_BASE}${endpoint}`, {
      headers: { 'x-apisports-key': API_KEY }
    });
    if (!res.ok) return null;
    const data = await res.json();
    setCache(endpoint, data);
    return data;
  } catch (e) {
    console.error('API error:', e.message);
    return null;
  }
}

// Static data (fallback when no API key)
const STATIC = {
  matches: [
    { id: 1080569, date: "2026-06-11", group: "A", home: "Mexico", away: "South Africa", homeScore: 2, awayScore: 0, status: "finished", venue: "Estadio Azteca, Mexico City" },
    { id: 1080570, date: "2026-06-11", group: "A", home: "Korea Republic", away: "Czechia", homeScore: 2, awayScore: 1, status: "finished", venue: "Mercedes-Benz Stadium, Atlanta" },
    { id: 1080571, date: "2026-06-12", group: "B", home: "Canada", away: "Bosnia & Herzegovina", homeScore: 1, awayScore: 1, status: "finished", venue: "BMO Field, Toronto" },
    { id: 1080572, date: "2026-06-12", group: "D", home: "United States", away: "Paraguay", homeScore: 4, awayScore: 1, status: "finished", venue: "SoFi Stadium, Los Angeles" },
    { id: 1080573, date: "2026-06-13", group: "B", home: "Qatar", away: "Switzerland", homeScore: 1, awayScore: 1, status: "finished", venue: "Lumen Field, Seattle" },
    { id: 1080574, date: "2026-06-13", group: "C", home: "Haiti", away: "Scotland", homeScore: 0, awayScore: 1, status: "finished", venue: "Hard Rock Stadium, Miami" },
    { id: 1080575, date: "2026-06-13", group: "C", home: "Brazil", away: "Morocco", homeScore: 1, awayScore: 1, status: "finished", venue: "MetLife Stadium, New York" },
    { id: 1080576, date: "2026-06-14", group: "D", home: "Australia", away: "Türkiye", homeScore: null, awayScore: null, status: "upcoming", venue: "AT&T Stadium, Dallas", time: "12:00 AM ET" },
    { id: 1080577, date: "2026-06-14", group: "E", home: "Germany", away: "Curaçao", homeScore: null, awayScore: null, status: "upcoming", venue: "Lincoln Financial Field, Philadelphia", time: "1:00 PM ET" },
    { id: 1080578, date: "2026-06-14", group: "F", home: "Netherlands", away: "Japan", homeScore: null, awayScore: null, status: "upcoming", venue: "Rose Bowl, Los Angeles", time: "4:00 PM ET" },
    { id: 1080579, date: "2026-06-14", group: "E", home: "Côte d'Ivoire", away: "Ecuador", homeScore: null, awayScore: null, status: "upcoming", venue: "Levi's Stadium, San Francisco", time: "7:00 PM ET" },
  ],
  // Match details (events, lineups, stats) for completed matches
  matchDetails: {
    1080569: {
      events: [
        { time: "38'", type: "goal", team: "home", player: "Julián Quiñones", assist: "César Huerta", detail: "Right footed shot from the centre of the box to the bottom left corner" },
        { time: "67'", type: "goal", team: "home", player: "Raúl Jiménez", assist: "Julián Quiñones", detail: "Header from very close range to the bottom left corner" },
        { time: "45+2'", type: "card", team: "away", player: "Teboho Mokoena", detail: "Yellow Card" },
        { time: "72'", type: "subst", team: "away", player: "Themba Zwane", assist: "Thapelo Morena" },
        { time: "80'", type: "subst", team: "home", player: "Diego Lainez", assist: "César Huerta" },
      ],
      lineup: {
        home: {
          formation: "4-3-3",
          coach: "Jaime Lozano",
          xi: [
            { number: 13, name: "Guillermo Ochoa", pos: "GK" },
            { number: 2, name: "Jorge Sánchez", pos: "RB" },
            { number: 3, name: "César Montes", pos: "CB" },
            { number: 5, name: "Johan Vásquez", pos: "CB" },
            { number: 23, name: "Jesús Gallardo", pos: "LB" },
            { number: 18, name: "Luis Chávez", pos: "CM" },
            { number: 4, name: "Edson Álvarez", pos: "CDM" },
            { number: 14, name: "Erick Sánchez", pos: "CM" },
            { number: 11, name: "César Huerta", pos: "RW" },
            { number: 9, name: "Raúl Jiménez", pos: "ST" },
            { number: 22, name: "Julián Quiñones", pos: "LW" },
          ],
          subs: [
            { number: 7, name: "Diego Lainez" },
            { number: 10, name: "Alexis Vega" },
            { number: 8, name: "Carlos Rodríguez" },
            { number: 6, name: "Gerardo Arteaga" },
            { number: 1, name: "Carlos Acevedo" },
          ]
        },
        away: {
          formation: "4-4-2",
          coach: "Hugo Broos",
          xi: [
            { number: 1, name: "Ronwen Williams", pos: "GK" },
            { number: 2, name: "Khuliso Mudau", pos: "RB" },
            { number: 5, name: "Siyanda Xulu", pos: "CB" },
            { number: 14, name: "Mothobi Mvala", pos: "CB" },
            { number: 6, name: "Aubrey Modiba", pos: "LB" },
            { number: 11, name: "Themba Zwane", pos: "RM" },
            { number: 4, name: "Teboho Mokoena", pos: "CM" },
            { number: 8, name: "Bongani Zungu", pos: "CM" },
            { number: 10, name: "Percy Tau", pos: "LM" },
            { number: 9, name: "Lyle Foster", pos: "ST" },
            { number: 17, name: "Evidence Makgopa", pos: "ST" },
          ],
          subs: [
            { number: 7, name: "Thapelo Morena" },
            { number: 12, name: "Sphelele Mkhulise" },
            { number: 3, name: "Terrence Mashego" },
            { number: 16, name: "Veli Mothwa" },
            { number: 20, name: "Grant Kekana" },
          ]
        }
      },
      stats: {
        home: { possession: 58, shots: 14, shotsOnTarget: 6, corners: 7, fouls: 11, offsides: 2, passes: 487, passAccuracy: 84 },
        away: { possession: 42, shots: 8, shotsOnTarget: 3, corners: 3, fouls: 14, offsides: 1, passes: 342, passAccuracy: 76 }
      }
    },
    1080570: {
      events: [
        { time: "24'", type: "goal", team: "home", player: "Hwang In-beom", assist: "Lee Kang-in", detail: "Left footed shot from outside the box to the top left corner" },
        { time: "56'", type: "goal", team: "away", player: "Ladislav Krejčí", assist: "Patrik Schick", detail: "Header from the centre of the box to the bottom right corner" },
        { time: "78'", type: "goal", team: "home", player: "Son Heung-min", assist: "Hwang Hee-chan", detail: "Right footed shot from the right side of the box to the bottom left corner" },
        { time: "33'", type: "card", team: "away", player: "Tomáš Souček", detail: "Yellow Card" },
        { time: "70'", type: "subst", team: "away", player: "Adam Hložek", assist: "Patrik Schick" },
        { time: "85'", type: "subst", team: "home", player: "Cho Gue-sung", assist: "Hwang Hee-chan" },
      ],
      lineup: {
        home: {
          formation: "4-2-3-1",
          coach: "Jürgen Klinsmann",
          xi: [
            { number: 1, name: "Kim Seung-gyu", pos: "GK" },
            { number: 2, name: "Kim Moon-hwan", pos: "RB" },
            { number: 4, name: "Kim Min-jae", pos: "CB" },
            { number: 19, name: "Kim Young-gwon", pos: "CB" },
            { number: 3, name: "Kim Jin-su", pos: "LB" },
            { number: 6, name: "Hwang In-beom", pos: "CM" },
            { number: 5, name: "Jung Woo-young", pos: "CDM" },
            { number: 7, name: "Son Heung-min", pos: "LW" },
            { number: 10, name: "Lee Kang-in", pos: "AM" },
            { number: 11, name: "Hwang Hee-chan", pos: "RW" },
            { number: 9, name: "Cho Gue-sung", pos: "ST" },
          ],
          subs: [
            { number: 16, name: "Hwang Ui-jo" },
            { number: 8, name: "Paik Seung-ho" },
            { number: 13, name: "Son Jun-ho" },
            { number: 17, name: "Na Sang-ho" },
            { number: 21, name: "Jo Hyeon-woo" },
          ]
        },
        away: {
          formation: "4-2-3-1",
          coach: "Ivan Hašek",
          xi: [
            { number: 1, name: "Matěj Kovář", pos: "GK" },
            { number: 5, name: "Vladimír Coufal", pos: "RB" },
            { number: 4, name: "Tomáš Holeš", pos: "CB" },
            { number: 3, name: "Tomáš Vlček", pos: "CB" },
            { number: 18, name: "David Jurásek", pos: "LB" },
            { number: 22, name: "Tomáš Souček", pos: "CM" },
            { number: 8, name: "Antonín Barák", pos: "CM" },
            { number: 14, name: "Ladislav Krejčí", pos: "LW" },
            { number: 10, name: "Patrik Schick", pos: "ST" },
            { number: 7, name: "Adam Hložek", pos: "RW" },
            { number: 13, name: "Mojmír Chytil", pos: "AM" },
          ],
          subs: [
            { number: 9, name: "Jan Kuchta" },
            { number: 11, name: "Václav Černý" },
            { number: 6, name: "Michal Sadílek" },
            { number: 16, name: "Tomáš Koubek" },
            { number: 2, name: "David Zima" },
          ]
        }
      },
      stats: {
        home: { possession: 52, shots: 12, shotsOnTarget: 5, corners: 5, fouls: 10, offsides: 3, passes: 432, passAccuracy: 81 },
        away: { possession: 48, shots: 10, shotsOnTarget: 4, corners: 4, fouls: 12, offsides: 1, passes: 401, passAccuracy: 79 }
      }
    },
    1080571: {
      events: [
        { time: "45'", type: "goal", team: "home", player: "Jonathan David", assist: "Alphonso Davies", detail: "Right footed shot from the centre of the box to the bottom left corner" },
        { time: "72'", type: "goal", team: "away", player: "Edin Džeko", assist: "Miralem Pjanić", detail: "Header from the centre of the box to the top right corner" },
        { time: "55'", type: "card", team: "home", player: "Mark-Anthony Kaye", detail: "Yellow Card" },
        { time: "65'", type: "subst", team: "away", player: "Smail Prevljak", assist: "Edin Džeko" },
      ],
      lineup: {
        home: {
          formation: "4-3-3",
          coach: "Jesse Marsch",
          xi: [
            { number: 18, name: "Maxime Crépeau", pos: "GK" },
            { number: 2, name: "Alistair Johnston", pos: "RB" },
            { number: 4, name: "Kamal Miller", pos: "CB" },
            { number: 5, name: "Steven Vitória", pos: "CB" },
            { number: 3, name: "Sam Adekugbe", pos: "LB" },
            { number: 8, name: "Mark-Anthony Kaye", pos: "CM" },
            { number: 14, name: "Atiba Hutchinson", pos: "CDM" },
            { number: 21, name: "Jonathan Osorio", pos: "CM" },
            { number: 11, name: "Tajon Buchanan", pos: "RW" },
            { number: 20, name: "Jonathan David", pos: "ST" },
            { number: 19, name: "Alphonso Davies", pos: "LW" },
          ],
          subs: [
            { number: 10, name: "Cyle Larin" },
            { number: 7, name: "Junior Hoilett" },
            { number: 6, name: "Samuel Piette" },
          ]
        },
        away: {
          formation: "4-4-2",
          coach: "Sergej Barbarez",
          xi: [
            { number: 1, name: "Ibrahim Šehić", pos: "GK" },
            { number: 2, name: "Eldar Ćivić", pos: "RB" },
            { number: 5, name: "Sead Kolašinac", pos: "CB" },
            { number: 6, name: "Dennis Hadžikadunić", pos: "CB" },
            { number: 3, name: "Anel Ahmedhodžić", pos: "LB" },
            { number: 10, name: "Miralem Pjanić", pos: "RM" },
            { number: 8, name: "Rade Krunić", pos: "CM" },
            { number: 7, name: "Muhamed Bešić", pos: "CM" },
            { number: 11, name: "Edin Višća", pos: "LM" },
            { number: 9, name: "Edin Džeko", pos: "ST" },
            { number: 17, name: "Smail Prevljak", pos: "ST" },
          ],
          subs: [
            { number: 14, name: "Amer Gojak" },
            { number: 16, name: "Sanjin Prcić" },
            { number: 4, name: "Dario Šarić" },
          ]
        }
      },
      stats: {
        home: { possession: 55, shots: 13, shotsOnTarget: 5, corners: 6, fouls: 9, offsides: 2, passes: 456, passAccuracy: 82 },
        away: { possession: 45, shots: 9, shotsOnTarget: 4, corners: 3, fouls: 13, offsides: 0, passes: 367, passAccuracy: 77 }
      }
    },
    1080572: {
      events: [
        { time: "12'", type: "goal", team: "home", player: "Folarin Balogun", assist: "Christian Pulisic", detail: "Right footed shot from the right side of the box to the bottom left corner" },
        { time: "28'", type: "goal", team: "home", player: "Folarin Balogun", assist: "Weston McKennie", detail: "Left footed shot from the centre of the box to the centre of the goal" },
        { time: "42'", type: "goal", team: "away", player: "Miguel Almirón", assist: null, detail: "Right footed shot from outside the box to the top left corner" },
        { time: "55'", type: "goal", team: "home", player: "Christian Pulisic", assist: "Tim Weah", detail: "Right footed shot from the left side of the six yard box to the bottom left corner" },
        { time: "78'", type: "goal", team: "home", player: "Gio Reyna", assist: "Folarin Balogun", detail: "Left footed shot from the centre of the box to the bottom right corner" },
        { time: "35'", type: "card", team: "away", player: "Gustavo Gómez", detail: "Yellow Card" },
        { time: "60'", type: "subst", team: "away", player: "Antonio Sanabria", assist: "Ramón Sosa" },
        { time: "70'", type: "subst", team: "home", player: "Brenden Aaronson", assist: "Tim Weah" },
      ],
      lineup: {
        home: {
          formation: "4-3-3",
          coach: "Gregg Berhalter",
          xi: [
            { number: 1, name: "Matt Turner", pos: "GK" },
            { number: 2, name: "Sergiño Dest", pos: "RB" },
            { number: 3, name: "Chris Richards", pos: "CB" },
            { number: 5, name: "Antonee Robinson", pos: "CB" },
            { number: 13, name: "Tim Ream", pos: "LB" },
            { number: 8, name: "Weston McKennie", pos: "CM" },
            { number: 4, name: "Tyler Adams", pos: "CDM" },
            { number: 6, name: "Yunus Musah", pos: "CM" },
            { number: 10, name: "Christian Pulisic", pos: "LW" },
            { number: 9, name: "Folarin Balogun", pos: "ST" },
            { number: 7, name: "Tim Weah", pos: "RW" },
          ],
          subs: [
            { number: 11, name: "Brenden Aaronson" },
            { number: 14, name: "Gio Reyna" },
            { number: 15, name: "Johnny Cardoso" },
          ]
        },
        away: {
          formation: "4-4-2",
          coach: "Daniel Garnero",
          xi: [
            { number: 1, name: "Roberto Fernández", pos: "GK" },
            { number: 2, name: "Robert Rojas", pos: "RB" },
            { number: 5, name: "Gustavo Gómez", pos: "CB" },
            { number: 3, name: "Omar Alderete", pos: "CB" },
            { number: 6, name: "Junior Alonso", pos: "LB" },
            { number: 11, name: "Miguel Almirón", pos: "RM" },
            { number: 8, name: "Richard Sánchez", pos: "CM" },
            { number: 16, name: "Mathías Villasanti", pos: "CM" },
            { number: 10, name: "Derlis González", pos: "LM" },
            { number: 9, name: "Ramón Sosa", pos: "ST" },
            { number: 7, name: "Antonio Sanabria", pos: "ST" },
          ],
          subs: [
            { number: 14, name: "Andrés Cubas" },
            { number: 15, name: "Héctor Martínez" },
            { number: 20, name: "Braian Ojeda" },
          ]
        }
      },
      stats: {
        home: { possession: 62, shots: 18, shotsOnTarget: 8, corners: 9, fouls: 8, offsides: 1, passes: 534, passAccuracy: 87 },
        away: { possession: 38, shots: 7, shotsOnTarget: 3, corners: 2, fouls: 15, offsides: 3, passes: 298, passAccuracy: 72 }
      }
    },
    1080573: {
      events: [
        { time: "52'", type: "goal", team: "home", player: "Akram Afif", assist: "Almoez Ali", detail: "Right footed shot from the centre of the box to the bottom right corner" },
        { time: "71'", type: "goal", team: "away", player: "Breel Embolo", assist: "Xherdan Shaqiri", detail: "Header from very close range to the bottom left corner" },
      ],
      lineup: {
        home: {
          formation: "4-2-3-1",
          coach: "Tintín Márquez",
          xi: [
            { number: 1, name: "Mahmoud Abunada", pos: "GK" },
            { number: 2, name: "Ró-Ró", pos: "RB" },
            { number: 15, name: "Bassam Al-Rawi", pos: "CB" },
            { number: 3, name: "Tarek Salman", pos: "CB" },
            { number: 14, name: "Homam Ahmed", pos: "LB" },
            { number: 6, name: "Abdulaziz Hatem", pos: "CM" },
            { number: 23, name: "Assim Madibo", pos: "CDM" },
            { number: 10, name: "Akram Afif", pos: "LW" },
            { number: 11, name: "Almoez Ali", pos: "ST" },
            { number: 17, name: "Ismaeel Mohammad", pos: "RW" },
            { number: 12, name: "Karim Boudiaf", pos: "AM" },
          ],
          subs: [
            { number: 7, name: "Ahmed Alaaeldin" },
            { number: 9, name: "Mohammed Muntari" },
          ]
        },
        away: {
          formation: "4-2-3-1",
          coach: "Murat Yakin",
          xi: [
            { number: 1, name: "Yann Sommer", pos: "GK" },
            { number: 2, name: "Kevin Mbabu", pos: "RB" },
            { number: 5, name: "Manuel Akanji", pos: "CB" },
            { number: 4, name: "Nico Elvedi", pos: "CB" },
            { number: 13, name: "Ricardo Rodríguez", pos: "LB" },
            { number: 10, name: "Granit Xhaka", pos: "CM" },
            { number: 8, name: "Remo Freuler", pos: "CM" },
            { number: 23, name: "Xherdan Shaqiri", pos: "RW" },
            { number: 7, name: "Breel Embolo", pos: "ST" },
            { number: 17, name: "Ruben Vargas", pos: "LW" },
            { number: 14, name: "Steven Zuber", pos: "AM" },
          ],
          subs: [
            { number: 9, name: "Haris Seferović" },
            { number: 11, name: "Renato Steffen" },
          ]
        }
      },
      stats: {
        home: { possession: 38, shots: 8, shotsOnTarget: 4, corners: 3, fouls: 16, offsides: 2, passes: 312, passAccuracy: 74 },
        away: { possession: 62, shots: 16, shotsOnTarget: 7, corners: 8, fouls: 10, offsides: 1, passes: 512, passAccuracy: 86 }
      }
    },
    1080574: {
      events: [
        { time: "83'", type: "goal", team: "away", player: "John McGinn", assist: "Andrew Robertson", detail: "Right footed shot from the centre of the box to the bottom left corner" },
        { time: "45'", type: "card", team: "home", player: "Dany Jean", detail: "Yellow Card" },
      ],
      lineup: {
        home: {
          formation: "4-4-2",
          coach: "Jean-Jacques Pierre",
          xi: [
            { number: 1, name: "Johny Placide", pos: "GK" },
            { number: 2, name: "Carlens Arcus", pos: "RB" },
            { number: 5, name: "Dany Jean", pos: "CB" },
            { number: 4, name: "Ricardo Adé", pos: "CB" },
            { number: 3, name: "Alex Christian", pos: "LB" },
            { number: 7, name: "Duckens Nazon", pos: "RM" },
            { number: 8, name: "Bryan Alceus", pos: "CM" },
            { number: 6, name: "Zachary Herivaux", pos: "CM" },
            { number: 11, name: "Frandzag Lubin", pos: "LM" },
            { number: 9, name: "Steeven Saba", pos: "ST" },
            { number: 10, name: "Jonel Désiré", pos: "ST" },
          ],
          subs: [
            { number: 14, name: "Mikael Cantave" },
            { number: 16, name: "Danny Jean" },
          ]
        },
        away: {
          formation: "3-4-2-1",
          coach: "Steve Clarke",
          xi: [
            { number: 1, name: "Angus Gunn", pos: "GK" },
            { number: 5, name: "Grant Hanley", pos: "CB" },
            { number: 6, name: "Kieran Tierney", pos: "CB" },
            { number: 13, name: "Scott McKenna", pos: "CB" },
            { number: 2, name: "Aaron Hickey", pos: "RWB" },
            { number: 8, name: "Callum McGregor", pos: "CM" },
            { number: 4, name: "Scott McTominay", pos: "CM" },
            { number: 3, name: "Andrew Robertson", pos: "LWB" },
            { number: 7, name: "John McGinn", pos: "AM" },
            { number: 11, name: "Ryan Christie", pos: "AM" },
            { number: 9, name: "Che Adams", pos: "ST" },
          ],
          subs: [
            { number: 10, name: "Stuart Armstrong" },
            { number: 14, name: "Kenny McLean" },
          ]
        }
      },
      stats: {
        home: { possession: 35, shots: 5, shotsOnTarget: 1, corners: 2, fouls: 14, offsides: 0, passes: 267, passAccuracy: 70 },
        away: { possession: 65, shots: 14, shotsOnTarget: 5, corners: 7, fouls: 8, offsides: 2, passes: 523, passAccuracy: 85 }
      }
    },
    1080575: {
      events: [
        { time: "31'", type: "goal", team: "home", player: "Vinícius Júnior", assist: "Raphinha", detail: "Right footed shot from the left side of the box to the bottom right corner" },
        { time: "68'", type: "goal", team: "away", player: "Hakim Ziyech", assist: "Azzedine Ounahi", detail: "Left footed shot from outside the box to the top left corner" },
        { time: "45'", type: "card", team: "home", player: "Casemiro", detail: "Yellow Card" },
        { time: "55'", type: "card", team: "away", player: "Nayef Aguerd", detail: "Yellow Card" },
      ],
      lineup: {
        home: {
          formation: "4-2-3-1",
          coach: "Dorival Júnior",
          xi: [
            { number: 1, name: "Alisson", pos: "GK" },
            { number: 2, name: "Danilo", pos: "RB" },
            { number: 4, name: "Marquinhos", pos: "CB" },
            { number: 3, name: "Éder Militão", pos: "CB" },
            { number: 6, name: "Alex Sandro", pos: "LB" },
            { number: 5, name: "Casemiro", pos: "CDM" },
            { number: 8, name: "Bruno Guimarães", pos: "CM" },
            { number: 11, name: "Raphinha", pos: "RW" },
            { number: 10, name: "Rodrygo", pos: "AM" },
            { number: 7, name: "Vinícius Júnior", pos: "LW" },
            { number: 9, name: "Richarlison", pos: "ST" },
          ],
          subs: [
            { number: 19, name: "Endrick" },
            { number: 17, name: "Gabriel Martinelli" },
          ]
        },
        away: {
          formation: "4-3-3",
          coach: "Walid Regragui",
          xi: [
            { number: 1, name: "Bono", pos: "GK" },
            { number: 2, name: "Achraf Hakimi", pos: "RB" },
            { number: 5, name: "Nayef Aguerd", pos: "CB" },
            { number: 6, name: "Romain Saïss", pos: "CB" },
            { number: 3, name: "Noussair Mazraoui", pos: "LB" },
            { number: 4, name: "Sofyan Amrabat", pos: "CDM" },
            { number: 8, name: "Azzedine Ounahi", pos: "CM" },
            { number: 15, name: "Selim Amallah", pos: "CM" },
            { number: 7, name: "Hakim Ziyech", pos: "RW" },
            { number: 9, name: "Youssef En-Nesyri", pos: "ST" },
            { number: 17, name: "Sofiane Boufal", pos: "LW" },
          ],
          subs: [
            { number: 11, name: "Abdelhamid Sabiri" },
            { number: 14, name: "Abderrazak Hamdallah" },
          ]
        }
      },
      stats: {
        home: { possession: 56, shots: 15, shotsOnTarget: 6, corners: 8, fouls: 12, offsides: 2, passes: 498, passAccuracy: 85 },
        away: { possession: 44, shots: 11, shotsOnTarget: 5, corners: 4, fouls: 14, offsides: 1, passes: 389, passAccuracy: 80 }
      }
    }
  }
};

const app = new Hono();

// API routes
app.get('/api/matches', async (c) => {
  if (API_KEY) {
    const data = await apiFetch(`/fixtures?league=${WC_LEAGUE}&season=${WC_SEASON}`);
    if (data?.response) return c.json(data.response);
  }
  return c.json(STATIC.matches);
});

app.get('/api/match/:id', async (c) => {
  const id = parseInt(c.req.param('id'));

  // Try API first
  if (API_KEY) {
    const [fixture, events, lineups, stats] = await Promise.all([
      apiFetch(`/fixtures?id=${id}`),
      apiFetch(`/fixtures/events?fixture=${id}`),
      apiFetch(`/fixtures/lineups?fixture=${id}`),
      apiFetch(`/fixtures/statistics?fixture=${id}`),
    ]);
    if (fixture?.response?.[0]) {
      return c.json({
        fixture: fixture.response[0],
        events: events?.response || [],
        lineups: lineups?.response || [],
        stats: stats?.response || [],
      });
    }
  }

  // Fallback to static data
  const match = STATIC.matches.find(m => m.id === id);
  const details = STATIC.matchDetails[id];
  if (match) {
    return c.json({ ...match, ...details });
  }
  return c.json({ error: 'Match not found' }, 404);
});

app.get('/api/standings', async (c) => {
  if (API_KEY) {
    const data = await apiFetch(`/standings?league=${WC_LEAGUE}&season=${WC_SEASON}`);
    if (data?.response) return c.json(data.response);
  }
  return c.json(null);
});

app.get('/api/topscorers', async (c) => {
  if (API_KEY) {
    const data = await apiFetch(`/players/topscorers?league=${WC_LEAGUE}&season=${WC_SEASON}`);
    if (data?.response) return c.json(data.response);
  }
  return c.json(null);
});

// Serve static files from dist
app.use('/*', serveStatic({ root: './dist' }));

// Fallback to index.html for SPA
app.get('*', async (c) => {
  const html = await readFile(join(DIST, 'index.html'), 'utf-8');
  return c.html(html);
});

serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' }, (info) => {
  console.log(`⚽ WC 2026 — The Pulse`);
  console.log(`🚀 Server running at http://0.0.0.0:${info.port}`);
  console.log(`📡 API-Football: ${API_KEY ? 'Connected' : 'No key (using static data)'}`);
});
