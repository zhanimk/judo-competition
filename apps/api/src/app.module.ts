import { ControlService } from './modules/control/control.service.js';
import { ControlController } from './modules/control/control.controller.js';
import { MatchesService } from './modules/matches/matches.service.js';
import { MatchesController } from './modules/matches/matches.controller.js';
import { LiveService } from './modules/matches/live.service.js';
import { PublicController } from './modules/public/public.controller.js';
import { PublicService } from './modules/public/public.service.js';
import { ProtocolsController } from './modules/protocols/protocols.controller.js';
import { ProtocolsService } from './modules/protocols/protocols.service.js';
import { DrawsController } from './modules/draws/draws.controller.js';
import { DrawsService } from './modules/draws/draws.service.js';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './modules/auth/auth.controller.js';
import { AuthService } from './modules/auth/auth.service.js';
import { AccessService } from './modules/auth/access.service.js';
import { AuthGuard } from './modules/auth/auth.guard.js';
import { TatamisController } from './modules/tatamis/tatamis.controller.js';
import { TatamisService } from './modules/tatamis/tatamis.service.js';
import { Module } from '@nestjs/common';
import { RosterController } from './modules/roster/roster.controller.js';
import { RosterService } from './modules/roster/roster.service.js';
import { DatabaseService } from './database/database.service.js';
import { TournamentsService } from './modules/tournaments/tournaments.service.js';
import { TournamentsController } from './modules/tournaments/tournaments.controller.js';
@Module({
  controllers: [
    ControlController,
    MatchesController,
    PublicController,
    ProtocolsController,
    DrawsController,
    TournamentsController,
    RosterController,
    TatamisController,
    AuthController,
  ],
  providers: [
    ControlService,
    MatchesService,
    LiveService,
    DatabaseService,
    PublicService,
    ProtocolsService,
    DrawsService,
    TournamentsService,
    RosterService,
    TatamisService,
    AuthService,
    AccessService,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
