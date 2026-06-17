// World Cup 2026 Data — Updated Jun 14, 2026

export const TEAM_FLAGS: Record<string, string> = {
  "Mexico": "🇲🇽", "Korea Republic": "🇰🇷", "Czechia": "🇨🇿", "South Africa": "🇿🇦",
  "Bosnia & Herzegovina": "🇧🇦", "Canada": "🇨🇦", "Qatar": "🇶🇦", "Switzerland": "🇨🇭",
  "Scotland": "🏴󠁧󠁢󠁳󠁣󠁴󠁿", "Brazil": "🇧🇷", "Morocco": "🇲🇦", "Haiti": "🇭🇹",
  "United States": "🇺🇸", "Australia": "🇦🇺", "Türkiye": "🇹🇷", "Paraguay": "🇵🇾",
  "Germany": "🇩🇪", "Curaçao": "🇨🇼", "Côte d'Ivoire": "🇨🇮", "Ecuador": "🇪🇨",
  "Netherlands": "🇳🇱", "Japan": "🇯🇵", "Sweden": "🇸🇪", "Tunisia": "🇹🇳",
  "Belgium": "🇧🇪", "Egypt": "🇪🇬", "IR Iran": "🇮🇷", "New Zealand": "🇳🇿",
  "Spain": "🇪🇸", "Cabo Verde": "🇨🇻", "Saudi Arabia": "🇸🇦", "Uruguay": "🇺🇾",
  "France": "🇫🇷", "Senegal": "🇸🇳", "Iraq": "🇮🇶", "Norway": "🇳🇴",
  "Argentina": "🇦🇷", "Algeria": "🇩🇿", "Austria": "🇦🇹", "Jordan": "🇯🇴",
  "Portugal": "🇵🇹", "Congo DR": "🇨🇩", "Uzbekistan": "🇺🇿", "Colombia": "🇨🇴",
  "England": "🇬🇧", "Croatia": "🇭🇷", "Ghana": "🇬🇭", "Panama": "🇵🇦"
};

export const GROUP_COLORS: Record<string, string> = {
  "A": "#00e5ff", "B": "#76ff03", "C": "#ffd600", "D": "#e040fb",
  "E": "#00e5ff", "F": "#76ff03", "G": "#ffd600", "H": "#e040fb",
  "I": "#00e5ff", "J": "#76ff03", "K": "#ffd600", "L": "#e040fb",
};

export interface Match {
  id: number;
  date: string;
  time: string;
  group: string;
  homeTeam: string;
  awayTeam: string;
  homeScore: number | null;
  awayScore: number | null;
  status: "finished" | "live" | "upcoming";
}

export interface PlayerStat {
  name: string;
  team: string;
  goals?: number;
  assists?: number;
  saves?: number;
  matchesPlayed: number;
}

export interface Standing {
  team: string;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goalsFor: number;
  goalsAgainst: number;
  goalDifference: number;
  points: number;
}

export interface GroupStanding {
  group: string;
  started: boolean;
  teams: Standing[];
}

export const completedMatches: Match[] = [
  { id: 1080569, date: "Thu, Jun 11", time: "", group: "A", homeTeam: "Mexico", awayTeam: "South Africa", homeScore: 2, awayScore: 0, status: "finished" },
  { id: 1080570, date: "Thu, Jun 11", time: "", group: "A", homeTeam: "Korea Republic", awayTeam: "Czechia", homeScore: 2, awayScore: 1, status: "finished" },
  { id: 1080571, date: "Fri, Jun 12", time: "", group: "B", homeTeam: "Canada", awayTeam: "Bosnia & Herzegovina", homeScore: 1, awayScore: 1, status: "finished" },
  { id: 1080572, date: "Fri, Jun 12", time: "", group: "D", homeTeam: "United States", awayTeam: "Paraguay", homeScore: 4, awayScore: 1, status: "finished" },
  { id: 1080573, date: "Sat, Jun 13", time: "", group: "B", homeTeam: "Qatar", awayTeam: "Switzerland", homeScore: 1, awayScore: 1, status: "finished" },
  { id: 1080574, date: "Sat, Jun 13", time: "", group: "C", homeTeam: "Haiti", awayTeam: "Scotland", homeScore: 0, awayScore: 1, status: "finished" },
  { id: 1080575, date: "Sat, Jun 13", time: "", group: "C", homeTeam: "Brazil", awayTeam: "Morocco", homeScore: 1, awayScore: 1, status: "finished" },
];

export const upcomingMatches: Match[] = [
  { id: 8, date: "Sun, Jun 14", time: "12:00 AM ET", group: "D", homeTeam: "Australia", awayTeam: "Türkiye", homeScore: null, awayScore: null, status: "upcoming" },
  { id: 9, date: "Sun, Jun 14", time: "1:00 PM ET", group: "E", homeTeam: "Germany", awayTeam: "Curaçao", homeScore: null, awayScore: null, status: "upcoming" },
  { id: 10, date: "Sun, Jun 14", time: "4:00 PM ET", group: "F", homeTeam: "Netherlands", awayTeam: "Japan", homeScore: null, awayScore: null, status: "upcoming" },
  { id: 11, date: "Sun, Jun 14", time: "7:00 PM ET", group: "E", homeTeam: "Côte d'Ivoire", awayTeam: "Ecuador", homeScore: null, awayScore: null, status: "upcoming" },
];

export const topScorers: PlayerStat[] = [
  { name: "Folarin Balogun", team: "United States", goals: 2, matchesPlayed: 2 },
  { name: "Julián Quiñones", team: "Mexico", goals: 1, matchesPlayed: 1 },
  { name: "Raúl Jiménez", team: "Mexico", goals: 1, matchesPlayed: 1 },
  { name: "Ladislav Krejčí", team: "Czechia", goals: 1, matchesPlayed: 1 },
  { name: "Hwang In-beom", team: "Korea Republic", goals: 1, matchesPlayed: 1 },
];

export const topGoalkeepers: PlayerStat[] = [
  { name: "Mahmoud Abunada", team: "Qatar", saves: 10, matchesPlayed: 1 },
  { name: "Matěj Kovář", team: "Czechia", saves: 5, matchesPlayed: 1 },
  { name: "Bono", team: "Morocco", saves: 4, matchesPlayed: 1 },
  { name: "Alisson", team: "Brazil", saves: 3, matchesPlayed: 1 },
  { name: "Kim Seung-gyu", team: "Korea Republic", saves: 3, matchesPlayed: 1 },
];

export const groupStandings: GroupStanding[] = [
  {
    group: "A", started: true,
    teams: [
      { team: "Mexico", played: 1, won: 1, drawn: 0, lost: 0, goalsFor: 2, goalsAgainst: 0, goalDifference: 2, points: 3 },
      { team: "Korea Republic", played: 1, won: 1, drawn: 0, lost: 0, goalsFor: 2, goalsAgainst: 1, goalDifference: 1, points: 3 },
      { team: "Czechia", played: 1, won: 0, drawn: 0, lost: 1, goalsFor: 1, goalsAgainst: 2, goalDifference: -1, points: 0 },
      { team: "South Africa", played: 1, won: 0, drawn: 0, lost: 1, goalsFor: 0, goalsAgainst: 2, goalDifference: -2, points: 0 },
    ]
  },
  {
    group: "B", started: true,
    teams: [
      { team: "Bosnia & Herzegovina", played: 1, won: 0, drawn: 1, lost: 0, goalsFor: 1, goalsAgainst: 1, goalDifference: 0, points: 1 },
      { team: "Canada", played: 1, won: 0, drawn: 1, lost: 0, goalsFor: 1, goalsAgainst: 1, goalDifference: 0, points: 1 },
      { team: "Qatar", played: 1, won: 0, drawn: 1, lost: 0, goalsFor: 1, goalsAgainst: 1, goalDifference: 0, points: 1 },
      { team: "Switzerland", played: 1, won: 0, drawn: 1, lost: 0, goalsFor: 1, goalsAgainst: 1, goalDifference: 0, points: 1 },
    ]
  },
  {
    group: "C", started: true,
    teams: [
      { team: "Scotland", played: 1, won: 1, drawn: 0, lost: 0, goalsFor: 1, goalsAgainst: 0, goalDifference: 1, points: 3 },
      { team: "Brazil", played: 1, won: 0, drawn: 1, lost: 0, goalsFor: 1, goalsAgainst: 1, goalDifference: 0, points: 1 },
      { team: "Morocco", played: 1, won: 0, drawn: 1, lost: 0, goalsFor: 1, goalsAgainst: 1, goalDifference: 0, points: 1 },
      { team: "Haiti", played: 1, won: 0, drawn: 0, lost: 1, goalsFor: 0, goalsAgainst: 1, goalDifference: -1, points: 0 },
    ]
  },
  {
    group: "D", started: true,
    teams: [
      { team: "United States", played: 1, won: 1, drawn: 0, lost: 0, goalsFor: 4, goalsAgainst: 1, goalDifference: 3, points: 3 },
      { team: "Australia", played: 0, won: 0, drawn: 0, lost: 0, goalsFor: 0, goalsAgainst: 0, goalDifference: 0, points: 0 },
      { team: "Türkiye", played: 0, won: 0, drawn: 0, lost: 0, goalsFor: 0, goalsAgainst: 0, goalDifference: 0, points: 0 },
      { team: "Paraguay", played: 1, won: 0, drawn: 0, lost: 1, goalsFor: 1, goalsAgainst: 4, goalDifference: -3, points: 0 },
    ]
  },
];

export const groupsNotStarted = [
  { group: "E", teams: ["Germany", "Curaçao", "Côte d'Ivoire", "Ecuador"] },
  { group: "F", teams: ["Netherlands", "Japan", "Sweden", "Tunisia"] },
  { group: "G", teams: ["Belgium", "Egypt", "IR Iran", "New Zealand"] },
  { group: "H", teams: ["Spain", "Cabo Verde", "Saudi Arabia", "Uruguay"] },
  { group: "I", teams: ["France", "Senegal", "Iraq", "Norway"] },
  { group: "J", teams: ["Argentina", "Algeria", "Austria", "Jordan"] },
  { group: "K", teams: ["Portugal", "Congo DR", "Uzbekistan", "Colombia"] },
  { group: "L", teams: ["England", "Croatia", "Ghana", "Panama"] },
];

export const tournamentStats = {
  gamesPlayed: 7,
  goalsScored: 17,
  teamsInPlay: 14,
  fixturesNext: 4,
};

// Simple Elo-based prediction model
export interface Prediction {
  homeTeam: string;
  awayTeam: string;
  homeWinProb: number;
  drawProb: number;
  awayWinProb: number;
  predictedScore: string;
  confidence: "high" | "medium" | "low";
}

const ELO_RATINGS: Record<string, number> = {
  "Argentina": 2180, "France": 2160, "England": 2120, "Brazil": 2100,
  "Portugal": 2090, "Spain": 2080, "Netherlands": 2050, "Germany": 2040,
  "Colombia": 2020, "Croatia": 2010, "Belgium": 2000, "Uruguay": 1990,
  "Japan": 1950, "Morocco": 1940, "United States": 1930, "Mexico": 1910,
  "Senegal": 1900, "Ecuador": 1880, "Türkiye": 1870, "Austria": 1860,
  "Switzerland": 1850, "Korea Republic": 1840, "Australia": 1820,
  "Egypt": 1810, "Côte d'Ivoire": 1800, "Norway": 1790, "Sweden": 1780,
  "Canada": 1770, "Paraguay": 1760, "Qatar": 1750, "Tunisia": 1740,
  "Saudi Arabia": 1730, "IR Iran": 1720, "Algeria": 1710, "Czechia": 1700,
  "Curaçao": 1550, "Cabo Verde": 1540, "Congo DR": 1600, "Jordan": 1580,
  "Haiti": 1500, "South Africa": 1650, "Bosnia & Herzegovina": 1680,
  "Ghana": 1690, "Panama": 1660, "New Zealand": 1570, "Iraq": 1620,
  "Scotland": 1750, "Uzbekistan": 1610,
};

export function predictMatch(homeTeam: string, awayTeam: string): Prediction {
  const homeElo = ELO_RATINGS[homeTeam] || 1500;
  const awayElo = ELO_RATINGS[awayTeam] || 1500;
  const homeAdvantage = 100;
  const expectedHome = 1 / (1 + Math.pow(10, (awayElo - homeElo - homeAdvantage) / 400));
  const expectedAway = 1 / (1 + Math.pow(10, (homeElo - awayElo + homeAdvantage) / 400));
  const eloDiff = Math.abs(homeElo - awayElo);
  const drawBase = Math.max(0.15, 0.32 - eloDiff * 0.0003);
  const total = expectedHome + expectedAway + drawBase;
  const homeWinProb = Math.round((expectedHome / total) * 100);
  const awayWinProb = Math.round((expectedAway / total) * 100);
  const drawProb = 100 - homeWinProb - awayWinProb;
  const homeXG = 1.2 + (homeElo - 1500) / 1000 + 0.15;
  const awayXG = 1.2 + (awayElo - 1500) / 1000;
  const predHome = Math.round(Math.max(0, homeXG));
  const predAway = Math.round(Math.max(0, awayXG));
  const confidence = eloDiff > 300 ? "high" : eloDiff > 150 ? "medium" : "low";
  return {
    homeTeam, awayTeam,
    homeWinProb: Math.max(5, Math.min(85, homeWinProb)),
    drawProb: Math.max(10, Math.min(40, drawProb)),
    awayWinProb: Math.max(5, Math.min(85, awayWinProb)),
    predictedScore: `${predHome} - ${predAway}`,
    confidence,
  };
}
